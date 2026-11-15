// A suffix's word-character run already supplies the old initial boundary;
// recognizing it directly avoids repeated searches through arbitrary prefixes.
const SECRET_KEY_PATTERN =
  /(?:\b(?:apiKey|apiToken|botToken|accessToken|refreshToken|(?:api_)?key|token|authorization|secret|password|credential|credentials?|cookie|set-cookie|auth)|[A-Z](?:Token|Key|Secret|Password)|_(?:key|token|secret|password))\b/i;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}
