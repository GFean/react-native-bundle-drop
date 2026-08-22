import { createTwoFilesPatch } from 'diff';
import chalk from 'chalk';
import { AiPatchPlan } from './types';
import { escapeTerminalControls } from './terminal-safety';

const BUNDLE_DROP_CONFIG_PATH = /^bundle\.drop\.config\.(js|cjs)$/;
const API_KEY_LITERAL = /(\bapiKey\s*:\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/g;

const redactPreviewSecrets = (file: string, content: string) =>
  BUNDLE_DROP_CONFIG_PATH.test(file)
    ? content.replace(API_KEY_LITERAL, '$1"<redacted>"')
    : content;

export function buildUnifiedDiff(params: {
  projectRoot: string;
  originals: Map<string, string>;
  changes: AiPatchPlan[];
}) {
  const diff = params.changes
    .map(change => {
      const original = redactPreviewSecrets(
        change.file,
        params.originals.get(change.file) ?? '',
      );
      const updated = redactPreviewSecrets(change.file, change.updated);
      return createTwoFilesPatch(
        `a/${change.file}`,
        `b/${change.file}`,
        original,
        updated,
        '',
        '',
        { context: 3 }
      );
    })
    .join('\n');
  return escapeTerminalControls(diff);
}

export function colorizeUnifiedDiff(diff: string) {
  return escapeTerminalControls(diff)
    .split('\n')
    .map(line => {
      if (line.startsWith('+++') || line.startsWith('---')) return chalk.bold(line);
      if (line.startsWith('+')) return chalk.green(line);
      if (line.startsWith('-')) return chalk.red(line);
      if (line.startsWith('@@')) return chalk.cyan(line);
      return line;
    })
    .join('\n');
}
