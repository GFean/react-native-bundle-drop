export class ProcessExitError extends Error {
  code: number | undefined;

  constructor(code: number | undefined) {
    super(`process.exit(${code})`);
    this.name = 'ProcessExitError';
    this.code = code;
  }
}

export const mockProcessExit = () =>
  jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ProcessExitError(code);
  }) as never);
