import fs from 'fs';
import path from 'path';

import { inspectProjectFile } from './safe-file-transaction';
import { stripCommentsAndStrings } from './native-setup-contract';

export type NativeEntrypointPlatform = 'android' | 'ios';

const toPosix = (filePath: string) => filePath.split(path.sep).join('/');

const maskXmlComments = (source: string) => {
  let masked = '';
  let cursor = 0;

  while (cursor < source.length) {
    const commentStart = source.indexOf('<!--', cursor);
    if (commentStart < 0) return masked + source.slice(cursor);

    masked += source.slice(cursor, commentStart);
    const commentEnd = source.indexOf('-->', commentStart + 4);
    const maskedEnd = commentEnd < 0 ? source.length : commentEnd + 3;
    masked += ' '.repeat(maskedEnd - commentStart);
    cursor = maskedEnd;
  }

  return masked;
};

const androidPackageFromPath = (relativePath: string) => {
  const match = relativePath.match(
    /^android\/app\/src\/main\/(?:java|kotlin)\/(.+)\/MainApplication\.(?:java|kt)$/,
  );
  return match ? match[1].split('/').join('.') : '';
};

const androidEntrypointClass = (relativePath: string, content: string) => {
  const declaredPackage = content.match(/(?:^|\n)\s*package\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;?/)?.[1];
  const packageName = declaredPackage || androidPackageFromPath(relativePath);
  return packageName ? `${packageName}.MainApplication` : 'MainApplication';
};

const androidManifestFiles = (projectRoot: string) => {
  const sourceRoot = path.join(projectRoot, 'android/app/src');
  let sourceSets: string[];
  try {
    const stat = fs.lstatSync(sourceRoot);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('Android source-set root is not a regular project directory.');
    }
    sourceSets = fs.readdirSync(sourceRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return sourceSets.flatMap(sourceSet => {
    if (/^(?:androidTest|benchmark|test|testFixtures|unitTest)$/i.test(sourceSet)) return [];
    const relativeDirectory = `android/app/src/${sourceSet}`;
    const directoryStat = fs.lstatSync(path.join(projectRoot, relativeDirectory));
    if (directoryStat.isSymbolicLink()) {
      throw new Error(`Android source-set path is a symbolic link: ${relativeDirectory}`);
    }
    if (!directoryStat.isDirectory()) return [];
    const relativeManifest = `${relativeDirectory}/AndroidManifest.xml`;
    return inspectProjectFile(projectRoot, relativeManifest).exists ? [relativeManifest] : [];
  }).sort();
};

const androidGradleNamespace = (projectRoot: string) => {
  for (const file of ['android/app/build.gradle', 'android/app/build.gradle.kts']) {
    const buildFile = inspectProjectFile(projectRoot, file);
    if (!buildFile.exists) continue;
    const namespace = buildFile.content.match(
      /(?:^|\n)\s*namespace\s*(?:=\s*)?["']([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)["']/,
    )?.[1];
    if (namespace) return namespace;
  }
  return '';
};

const androidAuthorityIssue = (projectRoot: string, entrypoint: string): string | null => {
  const entrypointFile = inspectProjectFile(projectRoot, entrypoint);
  if (!entrypointFile.exists) return `Android application entrypoint is missing: ${entrypoint}`;
  const entrypointClass = androidEntrypointClass(entrypoint, entrypointFile.content);
  const manifests = androidManifestFiles(projectRoot);
  const mainManifest = 'android/app/src/main/AndroidManifest.xml';
  if (!manifests.includes(mainManifest)) {
    return 'The main AndroidManifest.xml is missing; application startup authority is unknown.';
  }
  const gradleNamespace = androidGradleNamespace(projectRoot);
  for (const manifestPath of manifests) {
    const manifest = inspectProjectFile(projectRoot, manifestPath);
    const manifestSource = maskXmlComments(manifest.content);
    const applicationTags = [...manifestSource.matchAll(/<application\b[^>]*>/gi)];
    if (applicationTags.length > 1) {
      return `${manifestPath} has multiple application declarations.`;
    }
    const applicationTag = applicationTags[0]?.[0];
    if (!applicationTag) {
      if (manifestPath === mainManifest) {
        return `${manifestPath} has no application declaration to bind the native entrypoint.`;
      }
      continue;
    }
    const applicationNames = [...applicationTag.matchAll(
      /(?:^|\s)android:name\s*=\s*["']([^"']+)["']/gi,
    )].map(match => match[1].trim());
    if (applicationNames.length > 1) {
      return `${manifestPath} has multiple android:name application authorities.`;
    }
    if (!applicationNames.length) {
      if (manifestPath === mainManifest) {
        return `${manifestPath} does not explicitly name the application class.`;
      }
      continue;
    }
    const applicationName = applicationNames[0];
    if (/\$\{|[^A-Za-z0-9_.$]/.test(applicationName)) {
      return `${manifestPath} application class is not statically resolvable: ${applicationName}`;
    }
    const manifestPackage = manifestSource.match(
      /<manifest\b[^>]*\s+package\s*=\s*["']([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)["']/i,
    )?.[1] || '';
    const namespace = manifestPackage || gradleNamespace;
    if ((!applicationName.includes('.') || applicationName.startsWith('.')) && !namespace) {
      return `${manifestPath} uses a relative application class without a manifest package or Gradle namespace.`;
    }
    const expectedClass = applicationName.startsWith('.')
      ? `${namespace}${applicationName}`
      : applicationName.includes('.')
        ? applicationName
        : `${namespace}.${applicationName}`;
    if (expectedClass !== entrypointClass) {
      return `${manifestPath} starts ${expectedClass}, not ${entrypointClass}.`;
    }
  }
  return null;
};

const findIosAuthoritySources = (projectRoot: string) => {
  const iosRoot = path.join(projectRoot, 'ios');
  try {
    const rootStat = fs.lstatSync(iosRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error('iOS source root is not a regular project directory.');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { mainFiles: [], swiftFiles: [] };
    }
    throw error;
  }

  const pending = ['ios'];
  const mainFiles: string[] = [];
  const swiftFiles: string[] = [];
  let visited = 0;
  while (pending.length) {
    const relativeDirectory = pending.pop()!;
    for (const entry of fs.readdirSync(path.join(projectRoot, relativeDirectory), { withFileTypes: true })) {
      visited += 1;
      if (visited > 5000) throw new Error('iOS principal source scan exceeded 5000 entries.');
      if (entry.name === 'Pods' || entry.name === 'build' || entry.name === 'DerivedData') continue;
      const relativePath = toPosix(path.join(relativeDirectory, entry.name));
      const stat = fs.lstatSync(path.join(projectRoot, relativePath));
      if (stat.isSymbolicLink()) {
        throw new Error(`iOS principal source path is a symbolic link: ${relativePath}`);
      }
      if (stat.isDirectory()) pending.push(relativePath);
      else if (stat.isFile()) {
        if (/\.swift$/i.test(entry.name)) swiftFiles.push(relativePath);
        if (/^main\.(?:m|mm|swift)$/i.test(entry.name)) mainFiles.push(relativePath);
      }
    }
  }
  return { mainFiles: mainFiles.sort(), swiftFiles: swiftFiles.sort() };
};

const findBalancedCall = (source: string, name: string): string[] => {
  const calls: string[] = [];
  let searchFrom = 0;
  while (searchFrom < source.length) {
    const nameIndex = source.indexOf(name, searchFrom);
    if (nameIndex < 0) break;
    const previousCharacter = source[nameIndex - 1] || '';
    const nextCharacter = source[nameIndex + name.length] || '';
    if (/\w/.test(previousCharacter) || /\w/.test(nextCharacter)) {
      searchFrom = nameIndex + name.length;
      continue;
    }
    const opening = source.indexOf('(', nameIndex + name.length);
    if (opening < 0) break;
    let depth = 0;
    let quote = '';
    let escaped = false;
    for (let index = opening; index < source.length; index += 1) {
      const character = source[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === quote) quote = '';
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character === '(') depth += 1;
      if (character === ')') depth -= 1;
      if (depth === 0) {
        calls.push(source.slice(opening + 1, index));
        searchFrom = index + 1;
        break;
      }
    }
    if (depth !== 0) break;
  }
  return calls;
};

const stripCComments = (source: string) => {
  let output = '';
  let quote = '';
  let escaped = false;
  let blockCommentDepth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (quote) {
      output += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      output += character;
      continue;
    }
    if (character === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      output += '\n';
      continue;
    }
    if (character === '/' && next === '*') {
      blockCommentDepth = 1;
      index += 2;
      while (index < source.length && blockCommentDepth > 0) {
        if (source[index] === '/' && source[index + 1] === '*') {
          blockCommentDepth += 1;
          index += 2;
          continue;
        }
        if (source[index] === '*' && source[index + 1] === '/') {
          blockCommentDepth -= 1;
          index += 2;
          continue;
        }
        if (source[index] === '\n') output += '\n';
        index += 1;
      }
      index -= 1;
      continue;
    }
    output += character;
  }
  return output;
};

const topLevelCallArguments = (body: string) => {
  const argumentsList: string[] = [];
  const stack: string[] = [];
  let quote = '';
  let escaped = false;
  let start = 0;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if ('([{'.includes(character)) stack.push(character);
    else if (')]}'.includes(character)) stack.pop();
    else if (character === ',' && !stack.length) {
      argumentsList.push(body.slice(start, index).trim());
      start = index + 1;
    }
  }
  argumentsList.push(body.slice(start).trim());
  return argumentsList;
};

const exactPrincipalFromCall = (call: string, swift: boolean) => {
  const argumentsList = topLevelCallArguments(call);
  if (argumentsList.length !== 4) return null;
  const principal = argumentsList[3];
  if (swift) {
    if (/^NSStringFromClass\s*\(\s*AppDelegate\.self\s*\)$/.test(principal)) {
      return 'AppDelegate';
    }
    return /^"AppDelegate"$/.test(principal) ? 'AppDelegate' : null;
  }
  if (/^NSStringFromClass\s*\(\s*\[\s*AppDelegate\s+class\s*\]\s*\)$/.test(principal)) {
    return 'AppDelegate';
  }
  return /^@"AppDelegate"$/.test(principal) ? 'AppDelegate' : null;
};

const objcAuthorityIssue = (projectRoot: string, mainFiles: string[]): string | null => {
  if (mainFiles.length !== 1 || !/\.m{1,2}$/i.test(mainFiles[0])) {
    return mainFiles.length
      ? 'Multiple or conflicting iOS application principal sources were found.'
      : 'Objective-C main/UIApplicationMain principal source is missing.';
  }
  const mainFile = inspectProjectFile(projectRoot, mainFiles[0]);
  const calls = findBalancedCall(stripCComments(mainFile.content), 'UIApplicationMain');
  if (calls.length !== 1) return 'Exactly one UIApplicationMain call is required.';
  return exactPrincipalFromCall(calls[0], false)
    ? null
    : `UIApplicationMain argument 4 does not select AppDelegate.`;
};

const swiftAuthorityIssue = (
  projectRoot: string,
  entrypoint: string,
  mainFiles: string[],
  swiftFiles: string[],
) => {
  const principals = swiftFiles.flatMap(file => {
    const source = stripCommentsAndStrings(inspectProjectFile(projectRoot, file).content);
    return [...source.matchAll(
      /@(?:main|UIApplicationMain)\b[\s\n]*(?:(?:final|public|private|internal|open)\s+)*(?:class|struct)\s+([A-Za-z_$][\w$]*)/g,
    )].map(match => ({ file, name: match[1] }));
  });
  if (
    principals.length === 1 &&
    principals[0].name === 'AppDelegate' &&
    principals[0].file === entrypoint
  ) {
    return mainFiles.length
      ? 'An annotated Swift AppDelegate conflicts with an external main source.'
      : null;
  }
  if (principals.length) return 'Swift principal annotation does not uniquely select AppDelegate.';
  if (mainFiles.length !== 1 || !mainFiles[0].endsWith('/main.swift')) {
    return mainFiles.length
      ? 'Multiple or conflicting iOS application principal sources were found.'
      : 'Swift @main/UIApplicationMain principal is missing.';
  }
  const mainFile = inspectProjectFile(projectRoot, mainFiles[0]);
  const calls = findBalancedCall(stripCComments(mainFile.content), 'UIApplicationMain');
  if (calls.length !== 1 || !exactPrincipalFromCall(calls[0], true)) {
    return 'Swift main UIApplicationMain argument 4 does not select AppDelegate.';
  }
  return null;
};

export const findNativeEntrypointAuthorityIssue = (
  projectRoot: string,
  platform: NativeEntrypointPlatform,
  entrypoints: string[],
): string | null => {
  if (!entrypoints.length) return null;
  if (entrypoints.length > 1) {
    return `Multiple ${platform} application entrypoints were found; startup authority is ambiguous.`;
  }
  if (platform === 'android') return androidAuthorityIssue(projectRoot, entrypoints[0]);
  const { mainFiles, swiftFiles } = findIosAuthoritySources(projectRoot);
  if (entrypoints[0].endsWith('.swift')) {
    return swiftAuthorityIssue(projectRoot, entrypoints[0], mainFiles, swiftFiles);
  }
  return objcAuthorityIssue(projectRoot, mainFiles);
};
