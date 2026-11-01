type Token = { text: string; start: number; end: number };

/** A lexer for the small OpenStep dictionary form written by Xcode. */
function tokenize(source: string): Token[] | null {
  const tokens: Token[] = [];
  const pattern = /\s+|"(?:\\.|[^"\\])*"|[{}=;(),]|[^\s{}=;(),"]+/gy;
  let cursor = 0;
  while (cursor < source.length) {
    if (source.startsWith('/*', cursor)) {
      const end = source.indexOf('*/', cursor + 2);
      if (end < 0) return null;
      cursor = end + 2;
      continue;
    }
    if (source.startsWith('//', cursor)) {
      const end = source.indexOf('\n', cursor + 2);
      cursor = end < 0 ? source.length : end;
      continue;
    }
    pattern.lastIndex = cursor;
    const match = pattern.exec(source);
    if (!match) return null;
    cursor = pattern.lastIndex;
    if (!/^\s+$/.test(match[0])) tokens.push({ text: match[0], start: match.index, end: cursor });
  }
  return tokens;
}

/** Normalize only numeric CURRENT_PROJECT_VERSION literals in buildSettings.
 * Expressions, conditional keys, comments and other fields retain their bytes.
 */
export function normalizeIosProjectBuildNumber(source: string): string {
  const tokens = tokenize(source);
  if (!tokens) return source;
  const scopes: string[] = [];
  const replacements: Token[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.text === '{') {
      scopes.push(tokens[index - 1]?.text === '=' && tokens[index - 2]?.text === 'buildSettings' ? 'buildSettings' : '');
    } else if (token.text === '}') {
      scopes.pop();
    } else if (token.text === 'CURRENT_PROJECT_VERSION' && scopes[scopes.length - 1] === 'buildSettings' &&
        tokens[index + 1]?.text === '=' && tokens[index + 3]?.text === ';') {
      const value = tokens[index + 2];
      if (/^(?:\d+(?:\.\d+){0,2}|"\d+(?:\.\d+){0,2}")$/.test(value.text)) replacements.push(value);
    }
  }
  let result = source;
  for (const token of replacements.reverse()) {
    const marker = token.text.startsWith('"') ? '"<bundle-drop-build-number>"' : '<bundle-drop-build-number>';
    result = result.slice(0, token.start) + marker + result.slice(token.end);
  }
  return result;
}
