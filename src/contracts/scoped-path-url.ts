export interface ParsedScopedPathUrl {
  segments: string[];
  query: URLSearchParams | null;
  hadFragment: boolean;
}

export function parseScopedPathUrl(raw: string, scheme: string): ParsedScopedPathUrl {
  const prefix = `${scheme}:///`;
  if (!raw.startsWith(prefix)) throw new Error(`Invalid ${scheme} URL '${raw}' (expected ${prefix}).`);
  const rest = raw.slice(prefix.length);
  const firstQ = rest.indexOf('?');
  const firstH = rest.indexOf('#');
  const cut = [firstQ, firstH].filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? rest.length;
  const pathPart = rest.slice(0, cut);
  const queryPart = firstQ >= 0 && (firstH < 0 || firstQ < firstH) ? rest.slice(firstQ + 1, firstH < 0 ? undefined : firstH) : null;
  const hadFragment = firstH >= 0;
  const segments: string[] = [];
  for (const rawSeg of pathPart === '' ? [] : pathPart.split('/')) {
    if (rawSeg === '') throw new Error(`Invalid ${scheme} URL '${raw}' (empty/double/trailing slash).`);
    let seg: string;
    try {
      seg = decodeURIComponent(rawSeg);
    } catch {
      throw new Error(`Invalid ${scheme} URL '${raw}' (bad encoding).`);
    }
    if (seg === '.' || seg === '..' || seg.includes('/') || seg.includes('\\') || seg.includes('?') || seg.includes('#')) throw new Error(`Invalid ${scheme} URL '${raw}' (traversal or separator in segment).`);
    segments.push(seg);
  }
  const query = queryPart === null ? null : new URLSearchParams(queryPart);
  return { segments, query, hadFragment };
}

export function buildScopedPathUrl(scheme: string, segments: readonly string[]): string {
  const enc: string[] = [];
  for (const s of segments) {
    if (s === '' || s === '.' || s === '..' || /[/\\?#]/.test(s)) throw new Error(`Unrepresentable segment for ${scheme} URL: '${s}'.`);
    enc.push(encodeURIComponent(s));
  }
  return `${scheme}:///${enc.join('/')}`;
}
