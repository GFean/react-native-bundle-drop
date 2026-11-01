import fs from 'fs';
import path from 'path';
import type { ExpoBuildIdentity, MobilePlatform } from '../expo/types';

/** Optional upload context, never a runtime compatibility input. */
export function normalizeBuildNumber(value: unknown, platform: MobilePlatform): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const number = String(value).trim();
  if (platform === 'ios') return /^\d+(?:\.\d+){0,2}$/.test(number) && number.length <= 64 ? number : null;
  return /^\d+$/.test(number) && Number.isSafeInteger(Number(number)) &&
    Number(number) > 0 && Number(number) <= 2100000000 ? number : null;
}

export function expoBuildNumber(identity: ExpoBuildIdentity): string | null {
  const prefix = `${identity.appVersion}(`;
  if (!identity.nativeVersion.startsWith(prefix) || !identity.nativeVersion.endsWith(')')) return null;
  return normalizeBuildNumber(identity.nativeVersion.slice(prefix.length, -1), identity.platform);
}

function buildTokens(source: string): string[] {
  const pattern = /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_$][\w$]*|\d+(?:[A-Za-z_][\w]*)?|\r?\n|[^\s]/g;
  return [...source.matchAll(pattern)].map(match => match[0])
    .filter(token => !token.startsWith('//') && !token.startsWith('/*'));
}

/** Recognize literal statements only; do not evaluate Gradle or select a flavor. */
export function androidBuildNumber(source: string): string | null {
  const tokens = buildTokens(source);
  if (tokens.some(token => ['/', '"', "'", 'productFlavors', 'setVersionCode', 'versionCodeOverride'].includes(token))) return null;
  if (tokens.filter(token => token === 'versionCode').length !== 1) return null;
  const scopes: string[] = [];
  const index = tokens.indexOf('versionCode');
  for (let cursor = 0; cursor < index; cursor++) {
    const token = tokens[cursor];
    if (token === '{') scopes.push(tokens[cursor - 1] ?? '');
    else if (token === '}') scopes.pop();
  }
  if (scopes[scopes.length - 1] !== 'defaultConfig' || !['{', '\n', '\r\n', ';'].includes(tokens[index - 1])) return null;
  const numberIndex = index + (tokens[index + 1] === '=' ? 2 : 1);
  const after = tokens[numberIndex + 1];
  if (after !== undefined && !['\n', '\r\n', ';', '}'].includes(after)) return null;
  // A continuation on the next line is still an expression.
  const next = tokens.slice(numberIndex + 1).find(item => !['\n', '\r\n'].includes(item));
  if (['\n', '\r\n'].includes(after) && next && /^[+\-*%?.:(\[{&|^<>=!,]$/.test(next)) return null;
  return normalizeBuildNumber(tokens[numberIndex], 'android');
}

export function readAndroidBuildNumber(projectRoot: string, gradlePath?: string): string | null {
  const candidates = gradlePath ? [path.resolve(projectRoot, gradlePath)] : [
    path.join(projectRoot, 'android/app/build.gradle'),
    path.join(projectRoot, 'android/app/build.gradle.kts'),
  ];
  const files = candidates.filter(file => fs.existsSync(file));
  if (files.length !== 1) return null;
  return androidBuildNumber(fs.readFileSync(files[0], 'utf8'));
}

/** Resolve only the exact standard variable with unambiguous literal settings. */
export function iosBuildNumber(raw: unknown, projectRoot: string): string | null {
  if (raw !== '$(CURRENT_PROJECT_VERSION)' && raw !== '${CURRENT_PROJECT_VERSION}') return normalizeBuildNumber(raw, 'ios');
  const iosDir = path.join(projectRoot, 'ios');
  if (!fs.existsSync(iosDir)) return null;
  const projects = fs.readdirSync(iosDir).filter(name => name.endsWith('.xcodeproj'));
  if (projects.length !== 1) return null;
  const projectFile = path.join(iosDir, projects[0], 'project.pbxproj');
  if (!fs.existsSync(projectFile)) return null;
  const tokens = buildTokens(fs.readFileSync(projectFile, 'utf8')).filter(token => !['\n', '\r\n'].includes(token));
  // PBX source paths may contain unquoted slashes; validate the setting value below.
  if (tokens.some(token => ['"', "'"].includes(token))) return null;
  const scopes: string[] = [];
  const values = new Set<string>();
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === '{') scopes.push(tokens[index - 1] === '=' && tokens[index - 2] === 'buildSettings' ? 'settings' : '');
    else if (token === '}') scopes.pop();
    else if (token === 'CURRENT_PROJECT_VERSION') {
      if (scopes[scopes.length - 1] !== 'settings' || tokens[index + 1] !== '=') return null;
      const end = tokens.indexOf(';', index + 2);
      if (end === -1) return null;
      const value = normalizeBuildNumber(tokens.slice(index + 2, end).join('').replace(/^"|"$/g, ''), 'ios');
      if (!value) return null;
      values.add(value);
    }
  }
  return values.size === 1 ? [...values][0] : null;
}
