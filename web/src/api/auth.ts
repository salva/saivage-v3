/**
 * Auth token management.
 *
 * Reads the Saivage API token from:
 *   1. localStorage ('saivage_api_token') — set by the UI token entry
 *   2. VITE_SAIVAGE_API_TOKEN env variable
 *
 * URL query tokens are intentionally ignored and never persisted.
 */

const TOKEN_KEY = 'saivage_api_token';

export function getAuthToken(): string | null {
  // 1. localStorage override (set by the UI token entry component)
  if (typeof localStorage !== 'undefined') {
    const local = localStorage.getItem(TOKEN_KEY);
    if (local) return local;
  }
  // 2. Environment variable (Vite exposes VITE_ prefixed vars)
  if (typeof import.meta !== 'undefined' && import.meta.env) {
    const envToken = import.meta.env.VITE_SAIVAGE_API_TOKEN as string | undefined;
    if (envToken) return envToken;
  }
  return null;
}

/**
 * Set the API token in localStorage.
 * Used by the API token entry dialog in the UI.
 */
export function setAuthToken(token: string): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(TOKEN_KEY, token);
  }
}

/**
 * Clear the API token from localStorage.
 * Used by the API token entry dialog in the UI.
 */
export function clearAuthToken(): void {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem(TOKEN_KEY);
  }
}
