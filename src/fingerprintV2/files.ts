import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import createIgnore, { type Ignore } from 'ignore';
import { normalizeAndroidBuildNumber } from '../fingerprint/normalizeBuildNumber';
import { normalizeIosProjectBuildNumber } from '../fingerprint/normalizeIosBuildNumber';

export type Platform = 'android' | 'ios';
export type Source = { type: string; id: string; hash: string; reasons: string[] };
export type SkipPath = (file: string, directory: boolean) => boolean;

export const posix = (value: string): string => value.split(path.sep).join('/');
export const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
export const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_, entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    return Object.fromEntries(Object.entries(entry).sort(([left], [right]) => compareText(left, right)));
  });
}

type IgnoreRule = { directory: string; patterns: Ignore };

function readIgnoreRule(directory: string): IgnoreRule | undefined {
  try {
    return { directory, patterns: createIgnore().add(fs.readFileSync(path.join(directory, '.gitignore'), 'utf8')) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
}

function isIgnored(absolutePath: string, isDirectory: boolean, rules: IgnoreRule[]): boolean {
  let ignored = false;
  for (const rule of rules) {
    const relative = posix(path.relative(rule.directory, absolutePath));
    const result = rule.patterns.test(isDirectory ? `${relative}/` : relative);
    if (result.ignored) ignored = true;
    if (result.unignored) ignored = false;
  }
  return ignored;
}

function ancestorIgnoreRules(root: string, directory: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  let ancestor = directory;
  while (ancestor !== root) {
    ancestor = path.dirname(ancestor);
    const rule = readIgnoreRule(ancestor);
    if (rule) rules.push(rule);
  }
  return rules.reverse();
}

export function isProjectDirectoryIgnored(root: string, directory: string): boolean {
  return isIgnored(directory, true, ancestorIgnoreRules(root, directory));
}

function fileDigest(file: string, relative: string, normalizeBuildNumber: boolean): string {
  const bytes = fs.readFileSync(file);
  if (!normalizeBuildNumber) return digest(bytes);
  if (/\.gradle(?:\.kts)?$/.test(relative)) return digest(normalizeAndroidBuildNumber(bytes.toString('utf8')));
  if (/^ios\/[^/]+\.xcodeproj\/project\.pbxproj$/.test(relative)) {
    return digest(normalizeIosProjectBuildNumber(bytes.toString('utf8')));
  }
  return digest(bytes);
}

export function projectFileSources(input: {
  root: string;
  directory: string;
  idPrefix: string;
  reason: string;
  skip?: SkipPath;
  honorGitignore?: boolean;
  ignoreRoot?: string;
  normalizeBuildNumbers?: boolean;
}): Source[] {
  const { root, directory, idPrefix, reason, skip, honorGitignore, ignoreRoot = root, normalizeBuildNumbers } = input;
  const start = path.resolve(root, directory);
  const output: Source[] = [];
  const ancestors = new Set<string>();
  const initialRules = honorGitignore ? ancestorIgnoreRules(ignoreRoot, start) : [];

  function visit(absolute: string, rules: IgnoreRule[]): void {
    const realDirectory = fs.realpathSync(absolute);
    if (ancestors.has(realDirectory)) throw new Error(`Circular native input symlink: ${posix(path.relative(root, absolute))}`);
    ancestors.add(realDirectory);
    const localRule = honorGitignore ? readIgnoreRule(absolute) : undefined;
    const childrenRules = localRule ? [...rules, localRule] : rules;
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.gitignore') continue;
      const child = path.join(absolute, entry.name);
      const relative = posix(path.relative(root, child));
      if (skip?.(relative, entry.isDirectory()) || isIgnored(child, entry.isDirectory(), childrenRules)) continue;
      const stat = entry.isSymbolicLink() ? fs.statSync(child) : entry;
      if (stat.isDirectory()) {
        visit(child, childrenRules);
      } else if (stat.isFile()) {
        const id = idPrefix + posix(path.relative(start, child));
        output.push({ type: 'file', id, hash: fileDigest(child, relative, !!normalizeBuildNumbers), reasons: [reason] });
      }
    }
    ancestors.delete(realDirectory);
  }

  if (!isIgnored(start, true, initialRules)) visit(start, initialRules);
  return output.sort((left, right) => compareText(left.id, right.id));
}
