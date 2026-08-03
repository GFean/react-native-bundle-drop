import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Guards the Android 16 KB page-size compliance of the native xdelta library.
 *
 * Google Play rejects apps whose 64-bit native libraries (`arm64-v8a`,
 * `x86_64`) are not aligned to 16 KB ELF segments on Android 15+ devices. The
 * `libbundledropxdelta.so` shipped by this package previously linked with the
 * default 4 KB alignment, which failed the Play "16 KB page sizes" check.
 *
 * These tests assert the build configuration that forces 16 KB alignment so the
 * regression cannot silently return. They intentionally read the real build
 * files rather than a rebuilt binary so they run in the standard Jest gate
 * without an Android NDK toolchain.
 */

const repoRoot = join(__dirname, '..', '..', '..');
const cmakeListsPath = join(repoRoot, 'android', 'src', 'main', 'cpp', 'CMakeLists.txt');
const buildGradlePath = join(repoRoot, 'android', 'build.gradle');

const readRepoFile = (path: string): string => readFileSync(path, 'utf8');

const stripCmakeComments = (contents: string): string =>
  contents
    .split('\n')
    .map((line) => line.replace(/#.*$/, ''))
    .join('\n');

describe('android 16 KB page-size alignment', () => {
  describe('CMakeLists.txt', () => {
    const cmake = stripCmakeComments(readRepoFile(cmakeListsPath));

    it('applies link options to the bundledropxdelta target', () => {
      expect(cmake).toMatch(/target_link_options\s*\(\s*bundledropxdelta\b/);
    });

    it('forces a 16 KB max page size at link time', () => {
      expect(cmake).toContain('-Wl,-z,max-page-size=16384');
    });

    it('forces a 16 KB common page size at link time', () => {
      expect(cmake).toContain('-Wl,-z,common-page-size=16384');
    });

    it('does not link with the non-compliant 4 KB page size', () => {
      expect(cmake).not.toContain('max-page-size=4096');
      expect(cmake).not.toContain('common-page-size=4096');
    });
  });

  describe('build.gradle', () => {
    const buildGradle = readRepoFile(buildGradlePath);

    it('enables flexible page sizes for the NDK CMake build', () => {
      expect(buildGradle).toContain('-DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON');
    });
  });
});
