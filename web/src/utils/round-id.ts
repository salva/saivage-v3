export function optimisticUserRoundId(): string {
  return `r-user-${Date.now().toString(16).padStart(32, '0').slice(-32)}`;
}
