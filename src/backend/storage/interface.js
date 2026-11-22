/**
 * Storage adapter interface & default auth store factory for Home Pharmacy (`src/backend/storage/`).
 * Keeps auth credentials/tokens/OAuth grants strictly isolated from HubState so zero secrets
 * ever enter sync payloads, exports, or backups.
 */

import { createEmptyHubState, deepClone } from '../../core/index.js';

export function createEmptyAuthStore() {
  return {
    apiKeys: [],        // [{ id, name, scope, actor, memberId, keyHash, prefix, createdAt, lastUsedAt, revokedAt }]
    oauthClients: [],   // [{ client_id, client_name, redirect_uris, grant_types, response_types, token_endpoint_auth_method, client_secret_hash?, createdAt, revokedAt }]
    oauthCodes: [],     // [{ codeHash, clientId, redirectUri, codeChallenge, codeChallengeMethod, scope, memberId, resource, state, createdAt, expiresAt, usedAt }]
    oauthTokens: [],    // [{ id, grantId, clientId, clientName, memberId, scope, resource, accessHash, refreshHash, accessExpiresAt, refreshExpiresAt, createdAt, rotatedAt, revokedAt }]
    pushSubscriptions: [], // [{ id, memberId, endpoint, keys, createdAt }]
  };
}

export function normalizeAuthStore(raw) {
  const base = createEmptyAuthStore();
  if (!raw || typeof raw !== 'object') return base;
  return {
    apiKeys: Array.isArray(raw.apiKeys) ? deepClone(raw.apiKeys) : [],
    oauthClients: Array.isArray(raw.oauthClients) ? deepClone(raw.oauthClients) : [],
    oauthCodes: Array.isArray(raw.oauthCodes) ? deepClone(raw.oauthCodes) : [],
    oauthTokens: Array.isArray(raw.oauthTokens) ? deepClone(raw.oauthTokens) : [],
    pushSubscriptions: Array.isArray(raw.pushSubscriptions) ? deepClone(raw.pushSubscriptions) : [],
  };
}

export function ensureInitialHubState(raw) {
  if (!raw || typeof raw !== 'object') {
    return createEmptyHubState();
  }
  return deepClone(raw);
}
