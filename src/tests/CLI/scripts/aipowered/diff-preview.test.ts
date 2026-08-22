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

  it('redacts project API keys from both sides of a config preview', () => {
    const diff = buildUnifiedDiff({
      projectRoot: '/project',
      originals: new Map([
        [
          'bundle.drop.config.js',
          `module.exports = { project: { name: 'Old', apiKey: 'old-secret' } };\n`,
        ],
      ]),
      changes: [{
        file: 'bundle.drop.config.js',
        originalSha256: 'hash',
        updated: 'module.exports = { project: { name: "New", apiKey: "new-secret" } };\n',
        reason: 'Update config',
        confidence: 'high',
        decisionType: 'safe_auto_patch',
      }],
    });

    expect(diff).not.toContain('old-secret');
    expect(diff).not.toContain('new-secret');
    expect(diff).toContain('apiKey: "<redacted>"');
  });

  it('escapes terminal controls and bidi overrides in provider-authored diffs', () => {
    const diff = buildUnifiedDiff({
      projectRoot: '/project',
      originals: new Map([['app.config.js', 'export default {};\n']]),
      changes: [{
        file: 'app.config.js',
        originalSha256: 'hash',
        updated: 'export default {};\x1b[2J\rspoof\u202E\n',
        reason: 'Configure',
        confidence: 'high',
        decisionType: 'review_only_patch',
      }],
    });

    expect(diff).toContain('\\x1b[2J');
    expect(diff).toContain('\\rspoof');
    expect(diff).toContain('\\u202e');
    expect(diff).not.toContain('\x1b');
    expect(diff).not.toContain('\u202E');
  });
});
