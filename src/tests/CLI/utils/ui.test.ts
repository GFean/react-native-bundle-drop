const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

import { log, startLoadingStatus } from '../../../CLI/utils/ui';

describe('CLI/utils/ui', () => {
  afterEach(() => {
    consoleSpy.mockClear();
  });

  afterAll(() => {
    consoleSpy.mockRestore();
  });

  it('logs each UI helper with the expected label payload', () => {
    log.info('info');
    log.success('success');
    log.warn('warn');
    log.error('error');
    log.arrow('arrow');
    log.label('Platform', 'android');

    expect(consoleSpy).toHaveBeenNthCalledWith(1, expect.any(String), 'info');
    expect(consoleSpy).toHaveBeenNthCalledWith(2, expect.any(String), 'success');
    expect(consoleSpy).toHaveBeenNthCalledWith(3, expect.any(String), 'warn');
    expect(consoleSpy).toHaveBeenNthCalledWith(4, expect.any(String), 'error');
    expect(consoleSpy).toHaveBeenNthCalledWith(5, expect.any(String), 'arrow');
    expect(consoleSpy).toHaveBeenNthCalledWith(6, expect.stringContaining('Platform'));
  });

  it('prints a non-interactive loading status without starting a terminal spinner', () => {
    const originalIsTty = process.stdout.isTTY;
    process.stdout.isTTY = false;

    const status = startLoadingStatus('Waiting for backend');
    status.stop();

    expect(consoleSpy).toHaveBeenLastCalledWith(expect.any(String), 'Waiting for backend...');
    process.stdout.isTTY = originalIsTty;
  });

  it('animates and clears loading status in an interactive terminal', () => {
    jest.useFakeTimers();
    const originalIsTty = process.stdout.isTTY;
    const writeSpy = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    try {
      process.stdout.isTTY = true;

      const status = startLoadingStatus('Waiting for backend', 50);
      jest.advanceTimersByTime(150);
      status.stop();

      expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('Waiting for backend'));
      expect(writeSpy).toHaveBeenCalledWith(expect.stringContaining('Waiting for backend...'));
      expect(writeSpy).toHaveBeenLastCalledWith(expect.stringMatching(/^\r +\r$/));
    } finally {
      process.stdout.isTTY = originalIsTty;
      writeSpy.mockRestore();
      jest.useRealTimers();
    }
  });
});
