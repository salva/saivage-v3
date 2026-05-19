export const API_AUTH_REQUIRED_EVENT = 'saivage:api-auth-required';
export const API_AUTH_DISMISSED_SESSION_KEY = 'saivage:api-auth-banner-dismissed';

export interface ApiAuthRequiredDetail {
  status: number;
  path?: string;
}

export function isAuthBannerDismissedForSession(): boolean {
  try {
    return window.sessionStorage.getItem(API_AUTH_DISMISSED_SESSION_KEY) === 'true';
  } catch {
    return false;
  }
}

export function dismissAuthBannerForSession(): void {
  try {
    window.sessionStorage.setItem(API_AUTH_DISMISSED_SESSION_KEY, 'true');
  } catch {}
}

export function dispatchApiAuthRequired(detail: ApiAuthRequiredDetail): void {
  if (typeof window === 'undefined' || isAuthBannerDismissedForSession()) return;
  window.dispatchEvent(new CustomEvent<ApiAuthRequiredDetail>(API_AUTH_REQUIRED_EVENT, { detail }));
}
