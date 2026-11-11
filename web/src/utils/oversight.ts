/** A server sample, never a browser countdown or predicted execution time. */
export function formatOversightWait(milliseconds: number | null): string {
  if (milliseconds === null) return 'No armed wait';
  if (milliseconds === 0) return 'Timer wait elapsed; check not yet observed';
  const seconds = Math.ceil(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return `About ${hours ? `${hours}h ` : ''}${hours || minutes ? `${minutes}m ` : ''}${remainder}s`;
}
