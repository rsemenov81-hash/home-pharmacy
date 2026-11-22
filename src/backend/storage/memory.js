/**
 * In-Memory Storage Adapter for Home Pharmacy (unit tests & ephemeral runs).
 */

import { deepClone, SNAPSHOT_RETENTION_DAYS } from '../../core/index.js';
import { createEmptyAuthStore, ensureInitialHubState, normalizeAuthStore } from './interface.js';

export function createMemoryStorage(initialState = null) {
  let hubState = ensureInitialHubState(initialState);
  let authStore = createEmptyAuthStore();
  const snapshots = new Map(); // dateKey -> state

  return {
    kind: 'memory',

    async getHubState() {
      return deepClone(hubState);
    },

    async saveHubState(nextState) {
      hubState = deepClone(nextState);
      return deepClone(hubState);
    },

    async getAuthStore() {
      return normalizeAuthStore(authStore);
    },

    async saveAuthStore(nextAuth) {
      authStore = normalizeAuthStore(nextAuth);
      return normalizeAuthStore(authStore);
    },

    async listSnapshots() {
      return [...snapshots.keys()]
        .sort()
        .map((dateKey) => ({
          dateKey,
          createdAt: snapshots.get(dateKey)?.capturedAt || `${dateKey}T00:00:00.000Z`,
          rev: snapshots.get(dateKey)?.state?._rev ?? 0,
        }));
    },

    async getSnapshot(dateKey) {
      const entry = snapshots.get(dateKey);
      return entry ? deepClone(entry.state) : null;
    },

    async saveSnapshot(dateKey, state) {
      if (!snapshots.has(dateKey)) {
        snapshots.set(dateKey, {
          dateKey,
          capturedAt: new Date().toISOString(),
          state: deepClone(state),
        });
        // Prune oldest snapshots beyond retention window
        const keys = [...snapshots.keys()].sort();
        while (keys.length > SNAPSHOT_RETENTION_DAYS) {
          const oldest = keys.shift();
          snapshots.delete(oldest);
        }
      }
      return true;
    },

    async close() {
      // no-op
    },
  };
}
