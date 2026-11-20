import { cardIdSchema } from '../schemas/index.js';

export interface ParsedScopedPathUrl {
  segments: string[];
  query: URLSearchParams | null;
  hadFragment: boolean;
}

export function parseScopedPathUrl(raw: string, scheme: string): ParsedScopedPathUrl {
  const prefix = `${scheme}:///`;
  if (!raw.startsWith(prefix))
    throw new Error(`Invalid ${scheme} URL '${raw}' (expected ${prefix}).`);
  const rest = raw.slice(prefix.length);
  const firstQ = rest.indexOf('?');
  const firstH = rest.indexOf('#');
  const cut = [firstQ, firstH].filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? rest.length;
  const pathPart = rest.slice(0, cut);
  const queryPart =
    firstQ >= 0 && (firstH < 0 || firstQ < firstH)
      ? rest.slice(firstQ + 1, firstH < 0 ? undefined : firstH)
      : null;
  const hadFragment = firstH >= 0;
  const segments: string[] = [];
  for (const rawSeg of pathPart === '' ? [] : pathPart.split('/')) {
    if (rawSeg === '')
      throw new Error(`Invalid ${scheme} URL '${raw}' (empty/double/trailing slash).`);
    let seg: string;
    try {
      seg = decodeURIComponent(rawSeg);
    } catch {
      throw new Error(`Invalid ${scheme} URL '${raw}' (bad encoding).`);
    }
    if (seg === '.' || seg === '..' || seg.includes('/') || seg.includes('\\'))
      throw new Error(`Invalid ${scheme} URL '${raw}' (traversal or separator in segment).`);
    segments.push(seg);
  }
  const query = queryPart === null ? null : new URLSearchParams(queryPart);
  return { segments, query, hadFragment };
}

export function buildScopedPathUrl(scheme: string, segments: readonly string[]): string {
  const enc: string[] = [];
  for (const s of segments) {
    if (s === '' || s === '.' || s === '..' || /[/\\]/.test(s))
      throw new Error(`Unrepresentable segment for ${scheme} URL: '${s}'.`);
    enc.push(encodeURIComponent(s));
  }
  return `${scheme}:///${enc.join('/')}`;
}

export interface CardworkAddress {
  cardId: string;
  area: 'public' | 'repos';
  pathSegments: readonly string[];
}

export function encodeCardworkSegment(segment: string): string {
  if (segment === '' || segment === '.' || segment === '..' || /[/\\\0]/.test(segment))
    throw new Error('Invalid cardwork path segment.');
  return encodeURIComponent(segment).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function buildCardworkUrl({ cardId, area, pathSegments }: CardworkAddress): string {
  if (!cardIdSchema.safeParse(cardId).success || (area !== 'public' && area !== 'repos'))
    throw new Error('Invalid cardwork owner or area.');
  return `cardwork:///${[cardId, area, ...pathSegments].map(encodeCardworkSegment).join('/')}`;
}

export function parseCardworkUrl(raw: string): CardworkAddress {
  const { segments: [cardId = '', area, ...pathSegments], query, hadFragment } =
    parseScopedPathUrl(raw, 'cardwork');
  if (query !== null || hadFragment || (area !== 'public' && area !== 'repos'))
    throw new Error('Invalid cardwork URL.');
  const address: CardworkAddress = { cardId, area, pathSegments };
  if (buildCardworkUrl(address) !== raw) throw new Error('Noncanonical cardwork URL.');
  return address;
}
