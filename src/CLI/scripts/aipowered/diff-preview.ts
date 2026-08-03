import { createTwoFilesPatch } from 'diff';
import chalk from 'chalk';
import { AiPatchPlan } from './types';

export function buildUnifiedDiff(params: {
  projectRoot: string;
  originals: Map<string, string>;
  changes: AiPatchPlan[];
}) {
  return params.changes
    .map(change => {
      const original = params.originals.get(change.file) ?? '';
      return createTwoFilesPatch(
        `a/${change.file}`,
        `b/${change.file}`,
        original,
        change.updated,
        '',
        '',
        { context: 3 }
      );
    })
    .join('\n');
}

export function colorizeUnifiedDiff(diff: string) {
  return diff
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
