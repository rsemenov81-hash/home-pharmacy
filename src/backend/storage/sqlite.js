/**
 * Node 22 Persistent SQLite Storage Adapter (`node:sqlite` DatabaseSync).
 * Stores hub_state, isolated auth_store, and daily snapshots in a single ACID SQLite DB.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { deepClone, SNAPSHOT_RETENTION_DAYS } from '../../core/index.js';
import { ensureInitialHubState, normalizeAuthStore } from './interface.js';

export function createSqliteStorage({ dbPath, dataDir } = {}) {
  const resolvedPath =
    dbPath ||
    path.join(dataDir || path.resolve(process.cwd(), '.data'), 'home-pharmacy.sqlite');
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(resolvedPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS hp_kv (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const stmtGet = db.prepare('SELECT v, updated_at FROM hp_kv WHERE k = ?');
  const stmtPut = db.prepare(
    `INSERT INTO hp_kv (k, v, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`,
  );
  const stmtListSnaps = db.prepare(
    "SELECT k, v, updated_at FROM hp_kv WHERE k LIKE 'snapshot:%' ORDER BY k ASC",
  );
  const stmtDel = db.prepare('DELETE FROM hp_kv WHERE k = ?');

  function getJson(key) {
    const row = stmtGet.get(key);
    if (!row || typeof row.v !== 'string') return null;
    try {
      return JSON.parse(row.v);
    } catch {
      return null;
    }
  }

  function putJson(key, value) {
    stmtPut.run(key, JSON.stringify(value), new Date().toISOString());
  }

  // Bootstrap initial clean-slate HubState if not present
  if (!getJson('hub_state')) {
    putJson('hub_state', ensureInitialHubState(null));
  }

  return {
    kind: 'sqlite',
    dbPath: resolvedPath,

    async getHubState() {
      return ensureInitialHubState(getJson('hub_state'));
    },

    async saveHubState(nextState) {
      putJson('hub_state', nextState);
      return deepClone(nextState);
    },

    async getAuthStore() {
      return normalizeAuthStore(getJson('auth_store'));
    },

    async saveAuthStore(nextAuth) {
      const clean = normalizeAuthStore(nextAuth);
      putJson('auth_store', clean);
      return clean;
    },

    async listSnapshots() {
      const rows = stmtListSnaps.all();
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
      const entry = getJson(`snapshot:${dateKey}`);
      return entry?.state ? deepClone(entry.state) : null;
    },

    async saveSnapshot(dateKey, state) {
      const existing = getJson(`snapshot:${dateKey}`);
      if (!existing) {
        putJson(`snapshot:${dateKey}`, {
          dateKey,
          capturedAt: new Date().toISOString(),
          state,
        });
        const rows = stmtListSnaps.all();
        if (rows.length > SNAPSHOT_RETENTION_DAYS) {
          const dropCount = rows.length - SNAPSHOT_RETENTION_DAYS;
          for (let i = 0; i < dropCount; i++) {
            stmtDel.run(rows[i].k);
          }
        }
      }
      return true;
    },

    async close() {
      try {
        db.close();
      } catch {
        // ignore close errors
      }
    },
  };
}
