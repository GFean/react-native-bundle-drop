import { spawnSync } from 'child_process';
import { Minimatch } from 'minimatch';

describe('scheme-1 matching dependencies', () => {
  it('matches multi-globstar paths and treats empty trailing extglobs as empty components', () => {
    expect(new Minimatch('**/a/b/c/**/d/**', { dot: true }).match('a/b/c/d/file.kt')).toBe(true);
    for (const pattern of ['native/*(x)', 'native/?(x)']) {
      const matcher = new Minimatch(pattern, { dot: true });
      expect(matcher.match('native/')).toBe(false);
      expect(matcher.match('native/x')).toBe(true);
    }
  });

  it('bounds globstar-parent expansion in an isolated compiler process', () => {
    const result = spawnSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict');
      const { Minimatch } = require('minimatch');
      const matcher = new Minimatch('**/../x/'.repeat(32) + 'file.kt', {
        optimizationLevel: 2, braceExpandMax: 64,
      });
      assert(matcher.globParts.length <= 64);
    `], { cwd: process.cwd(), timeout: 5000, encoding: 'utf8' });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  });
});
