import { getOrCreateInstallId } from '../../fs/installId';
import { getMockFile, setMockFile } from '../mocks/native/fs';

jest.mock('../../context', () => require('../mocks/context'));
jest.mock('../../native/fs', () => require('../mocks/native/fs'));

const INSTALL_ID_PATH = '/mock/doc/bundle-drop/install-id.txt';

describe('fs/installId', () => {
  it('returns the existing install id when the file is present', async () => {
    setMockFile(INSTALL_ID_PATH, ' install-123 \n');

    await expect(getOrCreateInstallId()).resolves.toBe('install-123');
  });

  it('creates and persists a new install id when none exists', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_717_171_717_171);
    const randomSpy = jest
      .spyOn(Math, 'random')
      .mockReturnValueOnce(0.123456789)
      .mockReturnValueOnce(0.987654321);

    const installId = await getOrCreateInstallId();

    expect(installId).toMatch(/^[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$/);
    expect(getMockFile(INSTALL_ID_PATH)).toBe(installId);

    nowSpy.mockRestore();
    randomSpy.mockRestore();
  });
});
