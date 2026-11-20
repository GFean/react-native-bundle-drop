import path from 'node:path';

import { parseXmlPlist } from '../../utils/read-xml-plist';
import { readXcodeApplicationTargets } from '../ios-scene-target';
import { stripComments } from '../native-setup-contract';
import { hasUnsafeTerminalControl } from './terminal-safety';

type NativeSetupMetadata =
  | { applicationClass: string | null; packageName: string | null }
  | { namespace: string | null }
  | { sceneDelegateClasses: string[] }
  | { targets: { sourcePaths: string[]; infoPlistPaths: string[] }[] };

const MAX_METADATA_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_METADATA_ENTRIES = 8;

const dottedIdentifier = (value: unknown, allowLeadingDot = false): string | null => {
  if (typeof value !== 'string') return null;
  const identifier = value.trim();
  return identifier.length <= 240 &&
    (allowLeadingDot || !identifier.startsWith('.')) &&
    /^\.?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(identifier)
    ? identifier
    : null;
};

const xmlAttribute = (tag: string, name: string) => {
  const attributes = tag.matchAll(/(?:^|\s)([A-Za-z_][\w:.-]*)\s*=\s*(["'])([\s\S]*?)\2/g);
  const matches = [...attributes].filter(match => match[1] === name);
  return matches.length === 1 ? matches[0][3] : null;
};

const projectAndroidManifest = (source: string) => {
  const xml = source.replace(/<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/g, '');
  const manifest = /^\s*(?:<\?xml[^>]*>\s*)?<manifest\b((?:[^<>"']|"[^<"]*"|'[^<']*')*)>/.exec(xml);
  if (!manifest) return null;
  const applications = [...xml.matchAll(/<application\b((?:[^<>"']|"[^<"]*"|'[^<']*')*)>/g)];
  return {
    applicationClass: applications.length === 1
      ? dottedIdentifier(xmlAttribute(applications[0][1], 'android:name'), true)
      : null,
    packageName: dottedIdentifier(xmlAttribute(manifest[1], 'package')),
  };
};

const projectGradleNamespace = (source: string) => {
  const matches = stripComments(source).matchAll(
    /(?:^|[;{\n])[ \t]*namespace[ \t]*([=(])?[ \t]*(["'])([^"'\r\n]+)\2[ \t]*(\))?[ \t]*(?=[;\r\n}]|$)/g,
  );
  const values = [...new Set(
    [...matches].map(match =>
      (match[1] === '(') === Boolean(match[4]) ? dottedIdentifier(match[3]) : null,
    ),
  )];
  return { namespace: values.length === 1 ? values[0] : null };
};

const dictionary = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
    ? value as Record<string, unknown>
    : {};

const projectScenePlist = async (source: string) => {
  const plist = await parseXmlPlist(source);
  const manifest = dictionary(plist.UIApplicationSceneManifest);
  const roles = dictionary(manifest.UISceneConfigurations);
  const application = roles.UIWindowSceneSessionRoleApplication;
  if (!Array.isArray(application)) return { sceneDelegateClasses: [] };

  const classes = application.flatMap(configuration => {
    const name = dictionary(configuration).UISceneDelegateClassName;
    if (typeof name !== 'string') return [];
    const identifier = dottedIdentifier(name.replace(/^\$(?:\(PRODUCT_MODULE_NAME\)|\{PRODUCT_MODULE_NAME\})\./, ''));
    return identifier ? [identifier] : [];
  });
  return { sceneDelegateClasses: [...new Set(classes)].slice(0, MAX_METADATA_ENTRIES) };
};

const isIosMetadataPath = (file: string) =>
  file.startsWith('ios/') &&
  file.length <= 512 &&
  !/[\\\t\r\n]/.test(file) &&
  !hasUnsafeTerminalControl(file) &&
  file.split('/').every(part => part && !part.startsWith('.') &&
    !['node_modules', 'Pods', 'build', 'DerivedData'].includes(part));

const projectXcode = async (relativePath: string, source: string) => {
  const { parseOpenStep } = await import('plist');
  const directory = path.posix.dirname(path.posix.dirname(relativePath));
  const targets = readXcodeApplicationTargets(parseOpenStep(source), directory).map(target => ({
    sourcePaths: [...new Set(target.sourcePaths.filter(file =>
      isIosMetadataPath(file) && /\.(?:swift|m|mm)$/.test(file),
    ))].sort(),
    infoPlistPaths: [...new Set(target.infoPlistPaths.filter(isIosMetadataPath))]
      .sort().slice(0, MAX_METADATA_ENTRIES),
  }));
  return { targets };
};

/** Extract allowlisted native authority facts without returning any raw metadata. */
export async function projectNativeSetupMetadata(
  relativePath: string,
  source: string,
): Promise<NativeSetupMetadata | null> {
  if (Buffer.byteLength(source, 'utf8') > MAX_METADATA_SOURCE_BYTES) return null;
  try {
    if (/^android\/[^/]+\/src\/(?:.*\/)?AndroidManifest\.xml$/.test(relativePath)) {
      return projectAndroidManifest(source);
    }
    if (/^android\/[^/]+\/build\.gradle(?:\.kts)?$/.test(relativePath)) {
      return projectGradleNamespace(source);
    }
    if (!isIosMetadataPath(relativePath)) return null;
    if (relativePath.endsWith('.plist')) return await projectScenePlist(source);
    if (/\.xcodeproj\/project\.pbxproj$/.test(relativePath)) return await projectXcode(relativePath, source);
  } catch {
    return null;
  }
  return null;
}
