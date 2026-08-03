import chalk from 'chalk';

import {
  buildUnifiedDiff,
  colorizeUnifiedDiff,
} from '../../../../CLI/scripts/aipowered/diff-preview';

describe('CLI/scripts/aipowered/diff-preview', () => {
  it('builds a unified diff for every setup change', () => {
    const diff = buildUnifiedDiff({
      projectRoot: '/project',
      originals: new Map([['app.json', '{"expo":{}}\n']]),
      changes: [{
        file: 'app.json',
        originalSha256: 'hash',
        updated: '{"expo":{"plugins":["bundle-drop"]}}\n',
        reason: 'Configure Bundle Drop',
        confidence: 'high',
        decisionType: 'safe_auto_patch',
      }, {
        file: 'metro.config.js',
        originalSha256: 'hash',
        updated: 'module.exports = {};\n',
        reason: 'Configure Metro',
        confidence: 'high',
        decisionType: 'safe_auto_patch',
      }],
    });

    expect(diff).toContain('--- a/app.json');
    expect(diff).toContain('+++ b/app.json');
    expect(diff).toContain('--- a/metro.config.js');
    expect(diff).toContain('+module.exports = {};');
  });

  it('colors headers, additions, removals, hunks, and context lines', () => {
    const input = [
      '--- a/app.json',
      '+++ b/app.json',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      ' unchanged',
    ].join('\n');

    const output = colorizeUnifiedDiff(input);

    expect(output).toBe([
      chalk.bold('--- a/app.json'),
      chalk.bold('+++ b/app.json'),
      chalk.cyan('@@ -1 +1 @@'),
      chalk.red('-old'),
      chalk.green('+new'),
      ' unchanged',
    ].join('\n'));
  });
});
