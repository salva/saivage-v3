/**
 * Auth token source for the operator API client.
 *
 * Reads the Saivage API bearer token from:
 *   1. localStorage ('saivage_api_token') — operator-set browser configuration
 *      for bearer-auth deployments; there is no token entry UI
 *   2. VITE_SAIVAGE_API_TOKEN env variable
 *
 * URL query tokens are intentionally ignored and never persisted.
 */

const TOKEN_KEY = 'saivage_api_token';

export function getAuthToken(): string | null {
  // 1. localStorage (operator-set browser configuration, no UI)
  const local = localStorage.getItem(TOKEN_KEY);
  if (local) return local;
  // 2. Environment variable (Vite exposes VITE_ prefixed vars)
  const envToken = import.meta.env.VITE_SAIVAGE_API_TOKEN as string | undefined;
  if (envToken) return envToken;
  return null;
}
