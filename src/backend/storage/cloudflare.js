/**
 * Cloudflare Workers Storage Adapter: D1 (strongly consistent primary — required for
 * OAuth 2.1 DCR/PKCE single-use codes & refresh rotation) + KV fallback.
 */

import { deepClone, SNAPSHOT_RETENTION_DAYS } from '../../core/index.js';
import { ensureInitialHubState, normalizeAuthStore } from './interface.js';

export function createCloudflareStorage(env = {}) {
  const db = env?.DB || null;
  const kv = env?.KV || null;

  if (db) {
    let initialized = false;
    async function initD1() {
      if (initialized) return;
      await db
        .prepare(
          `CREATE TABLE IF NOT EXISTS hp_kv (
            k TEXT PRIMARY KEY,
            v TEXT NOT NULL,
            updated_at TEXT NOT NULL
          )`,
        )
        .run();
      initialized = true;
    }

    async function getJson(key) {
      await initD1();
      const row = await db.prepare('SELECT v FROM hp_kv WHERE k = ?').bind(key).first();
      if (!row || typeof row.v !== 'string') return null;
      return JSON.parse(row.v);
    }

    async function putJson(key, value) {
      await initD1();
      const now = new Date().toISOString();
      await db
        .prepare(
          `INSERT INTO hp_kv (k, v, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`,
        )
        .bind(key, JSON.stringify(value), now)
        .run();
    }

    return {
      kind: 'd1',
      async getHubState() {
        return ensureInitialHubState(await getJson('hub_state'));
      },
      async saveHubState(state) {
        await putJson('hub_state', state);
        return deepClone(state);
      },
      async getAuthStore() {
        return normalizeAuthStore(await getJson('auth_store'));
      },
      async saveAuthStore(store) {
        const clean = normalizeAuthStore(store);
        await putJson('auth_store', clean);
        return clean;
      },
      async listSnapshots() {
        await initD1();
        const res = await db
          .prepare("SELECT k, v, updated_at FROM hp_kv WHERE k LIKE 'snapshot:%' ORDER BY k ASC")
          .all();
        const rows = Array.isArray(res?.results) ? res.results : [];
        return rows.map((r) => {
          const dateKey = r.k.slice('snapshot:'.length);
          let parsed = null;
          try {
            parsed = JSON.parse(r.v);
          } catch {
            parsed = null;
          }
          return {
            dateKey,
            createdAt: parsed?.capturedAt || r.updated_at,
            rev: parsed?.state?._rev ?? 0,
          };
        });
      },
      async getSnapshot(dateKey) {
        const entry = await getJson(`snapshot:${dateKey}`);
        return entry?.state ? deepClone(entry.state) : null;
      },
      async saveSnapshot(dateKey, state) {
        const existing = await getJson(`snapshot:${dateKey}`);
        if (!existing) {
          await putJson(`snapshot:${dateKey}`, {
            dateKey,
            capturedAt: new Date().toISOString(),
            state,
          });
          const all = await this.listSnapshots();
          if (all.length > SNAPSHOT_RETENTION_DAYS) {
            const toDrop = all.slice(0, all.length - SNAPSHOT_RETENTION_DAYS);
            for (const snap of toDrop) {
              await db.prepare('DELETE FROM hp_kv WHERE k = ?').bind(`snapshot:${snap.dateKey}`).run();
            }
          }
        }
        return true;
      },
      async close() {},
    };
  }

  if (kv) {
    return {
      kind: 'kv',
      async getHubState() {
        const raw = await kv.get('hub_state', 'json');
        return ensureInitialHubState(raw);
      },
      async saveHubState(state) {
        await kv.put('hub_state', JSON.stringify(state));
        return deepClone(state);
      },
      async getAuthStore() {
        const raw = await kv.get('auth_store', 'json');
        return normalizeAuthStore(raw);
      },
      async saveAuthStore(store) {
        const clean = normalizeAuthStore(store);
        await kv.put('auth_store', JSON.stringify(clean));
        return clean;
      },
      async listSnapshots() {
        const idx = (await kv.get('snapshot_index', 'json')) || [];
        return Array.isArray(idx) ? idx : [];
      },
      async getSnapshot(dateKey) {
        const entry = await kv.get(`snapshot:${dateKey}`, 'json');
        return entry?.state ? deepClone(entry.state) : null;
      },
      async saveSnapshot(dateKey, state) {
        const idx = await this.listSnapshots();
        if (!idx.some((s) => s.dateKey === dateKey)) {
          const capturedAt = new Date().toISOString();
          await kv.put(`snapshot:${dateKey}`, JSON.stringify({ dateKey, capturedAt, state }));
          const nextIdx = [...idx, { dateKey, createdAt: capturedAt, rev: state?._rev ?? 0 }].sort((a, b) =>
            a.dateKey.localeCompare(b.dateKey),
          );
          while (nextIdx.length > SNAPSHOT_RETENTION_DAYS) {
            const oldest = nextIdx.shift();
            await kv.delete(`snapshot:${oldest.dateKey}`);
          }
          await kv.put('snapshot_index', JSON.stringify(nextIdx));
        }
        return true;
      },
      async close() {},
    };
  }

  throw new Error('Cloudflare storage requires env.DB (D1) or env.KV binding.');
}
