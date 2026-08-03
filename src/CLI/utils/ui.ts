import chalk from 'chalk';
import figures from 'figures';

export const log = {
  info: (msg: string) => console.log(chalk.blue(figures.pointer), msg),
  success: (msg: string) => console.log(chalk.green(figures.tick), msg),
  warn: (msg: string) => console.log(chalk.yellow(figures.warning), msg),
  error: (msg: string) => console.log(chalk.red(figures.cross), msg),
  arrow: (msg: string) => console.log(chalk.cyan(figures.arrowRight), msg),
  label: (label: string, value: string) => console.log(`${chalk.gray(label)}: ${chalk.white(value)}`),
};

export function startLoadingStatus(message: string, intervalMs = 300) {
  const frames = ['', '.', '..', '...'];
  let frameIndex = 0;
  let lastLineLength = 0;

  if (!process.stdout.isTTY) {
    log.arrow(`${message}...`);
    return {
      stop: () => undefined,
    };
  }

  const render = () => {
    const line = `${chalk.cyan(figures.arrowRight)} ${message}${frames[frameIndex]}`;
    lastLineLength = Math.max(lastLineLength, line.length);
    process.stdout.write(`\r${line}${' '.repeat(Math.max(0, lastLineLength - line.length))}`);
    frameIndex = (frameIndex + 1) % frames.length;
  };

  render();
  const timer = setInterval(render, intervalMs);

  return {
    stop: () => {
      clearInterval(timer);
      process.stdout.write(`\r${' '.repeat(lastLineLength)}\r`);
    },
  };
}
