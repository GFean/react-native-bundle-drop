import * as fs from 'fs';
import * as path from 'path';

const XCODE_VAR_RE = /\$\(([^)]+)\)/;

export function resolveXcodeBuildSetting(
  projectRoot: string,
  variableName: string,
): string | null {
  const iosDir = path.join(projectRoot, 'ios');
  if (!fs.existsSync(iosDir)) return null;

  const xcodeproj = fs.readdirSync(iosDir).find(f => f.endsWith('.xcodeproj'));
  if (!xcodeproj) return null;

  const pbxprojPath = path.join(iosDir, xcodeproj, 'project.pbxproj');
  if (!fs.existsSync(pbxprojPath)) return null;

  const content = fs.readFileSync(pbxprojPath, 'utf-8');
  const pattern = new RegExp(`${variableName}\\s*=\\s*([^;]+);`);
  const match = content.match(pattern);
  if (!match) return null;

  const value = match[1].trim().replace(/^["']|["']$/g, '');
  if (!value || XCODE_VAR_RE.test(value)) return null;

  return value;
}

export function resolveIosPlistVersion(
  rawVersion: string,
  projectRoot: string,
): string | null {
  const xcodeVarMatch = rawVersion.match(XCODE_VAR_RE);
  if (!xcodeVarMatch) return rawVersion;

  const variableName = xcodeVarMatch[1];
  const resolved = resolveXcodeBuildSetting(projectRoot, variableName);
  if (resolved) {
    console.warn(
      `⚠️ Info.plist contains $(${variableName}); resolved to "${resolved}" from .pbxproj`,
    );
    return resolved;
  }

  console.error(
    `❌ Info.plist contains $(${variableName}) which could not be resolved.\n` +
    `   Pass --version=x.y.z explicitly, or ensure MARKETING_VERSION is set in your .pbxproj.`,
  );
  return null;
}
