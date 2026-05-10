/**
 * Auth token management.
 *
 * Reads the Saivage API token from:
 *   1. localStorage ('saivage_api_token') — set by the UI token entry
 *   2. URL query parameter 'token'
 *   3. VITE_SAIVAGE_API_TOKEN env variable
 */

export function getAuthToken(): string | null {
  // 1. localStorage override (set by the UI token entry component)
  if (typeof localStorage !== 'undefined') {
    const local = localStorage.getItem('saivage_api_token');
    if (local) return local;
  }
  // 2. URL query parameter
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    const urlToken = params.get('token');
    if (urlToken) return urlToken;
  }
  // 3. Environment variable (Vite exposes VITE_ prefixed vars)
  if (typeof import.meta !== 'undefined' && import.meta.env) {
    const envToken = import.meta.env.VITE_SAIVAGE_API_TOKEN as string | undefined;
    if (envToken) return envToken;
  }
  return null;
}
