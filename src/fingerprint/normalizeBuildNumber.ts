type Token = { text: string; start: number; end: number };

/** Tokenize enough Groovy/Kotlin to distinguish code from comments and strings.
 * This deliberately does not evaluate expressions or interpret build scripts.
 */
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_$][\w$]*|\d+(?:[A-Za-z_][\w]*)?|\r?\n|[^\s]/g;
  for (const match of source.matchAll(pattern)) {
    const text = match[0];
    if (text.startsWith('//') || text.startsWith('/*')) continue;
    tokens.push({ text, start: match.index!, end: match.index! + text.length });
  }
  return tokens;
}

/** Only normalize literal `versionCode 1` / `versionCode = 1` statements inside
 * defaultConfig or a productFlavors block. All ambiguous expressions stay intact.
 */
export function normalizeAndroidBuildNumber(source: string): string {
  const tokens = tokenize(source);
  // Slashy strings and incomplete literals are outside the recognized grammar.
  if (tokens.some(token => ['/', '"', "'"].includes(token.text))) return source;
  const scopes: string[] = [];
  const replacements: Token[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.text === '{') {
      scopes.push(tokens[index - 1]?.text ?? '');
    } else if (token.text === '}') {
      scopes.pop();
    } else if (token.text === 'versionCode' && (scopes.includes('defaultConfig') || scopes.includes('productFlavors'))) {
      const before = tokens[index - 1]?.text;
      const numberIndex = index + (tokens[index + 1]?.text === '=' ? 2 : 1);
      const number = tokens[numberIndex];
      const after = tokens[numberIndex + 1]?.text;
      const nextLineToken = tokens.slice(numberIndex + 1).find(candidate => !['\n', '\r\n'].includes(candidate.text))?.text;
      const hasContinuation = ['\n', '\r\n'].includes(after) &&
        ['+', '-', '*', '%', '.', '?', ':', '(', '[', '{', '&', '|', '^', '<', '>', '=', '!', ','].includes(nextLineToken ?? '');
      if (['\n', '\r\n', '{', ';'].includes(before) && /^\d+$/.test(number?.text ?? '') &&
          (after === undefined || ['\n', '\r\n', ';', '}'].includes(after)) && !hasContinuation) {
        replacements.push(number);
      }
    }
  }
  let result = source;
  for (const token of replacements.reverse()) {
    result = result.slice(0, token.start) + '<bundle-drop-build-number>' + result.slice(token.end);
  }
  return result;
}
