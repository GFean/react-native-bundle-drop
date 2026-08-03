import { tryInstallPatchTransport } from '../../patch-engine/patchTransport';
import { mockReportPatchApplyFailure } from '../mocks/api/clientApi';
import { mockInstallFromPatchSet } from '../mocks/install/installFromZip';
import { resetNativeFsMocks } from '../mocks/native/fs';

jest.mock('../../context', () => ({
  runtimeVersion: undefined,
}));
jest.mock('../../native/fs', () => require('../mocks/native/fs'));
jest.mock('../../api/clientApi', () => require('../mocks/api/clientApi'));
jest.mock('../../fs/installId', () => ({
  getOrCreateInstallId: jest.fn(async () => 'install-id'),
}));
jest.mock('../../patch-engine/installFromPatchSet', () => ({
  installFromPatchSet: require('../mocks/install/installFromZip').installFromPatchSet,
}));

describe('patch-engine/patchTransport', () => {
  beforeEach(() => {
    resetNativeFsMocks();
    mockInstallFromPatchSet.mockReset();
    mockReportPatchApplyFailure.mockResolvedValue({ data: undefined } as never);
  });

  it('accepts asset-only patch transport and forwards the selected algorithm', async () => {
    mockInstallFromPatchSet.mockResolvedValueOnce({
      bundlePath: '/bundles/target/main.jsbundle',
      metadataFromZip: { hash: 'target-hash' },
    });

    await expect(
      tryInstallPatchTransport({
        target: {
          mode: 'patch',
          hash: 'target-hash',
          baseHash: 'base-hash',
          patchSet: {
            algorithm: 'asset-only-v1',
            patchesUrl: 'https://cdn.example.com/patch.zip',
            patchSetHash: 'patch-hash',
          },
        },
        projectSlug: 'bundle-drop-app',
        platform: 'android',
      }),
    ).resolves.toEqual(expect.objectContaining({
      bundlePath: '/bundles/target/main.jsbundle',
    }));

    expect(mockInstallFromPatchSet).toHaveBeenCalledWith(
      expect.objectContaining({
        algorithm: 'asset-only-v1',
      })
    );
  });

  it('reports an empty runtime version when neither resolve nor config provides one', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      mockInstallFromPatchSet.mockRejectedValueOnce(new Error('patch decode failed'));

      await expect(
        tryInstallPatchTransport({
          target: {
            mode: 'patch',
            hash: 'target-hash',
            baseHash: 'base-hash',
            patchSet: {
              algorithm: 'xdelta3-vcdiff',
              patchesUrl: 'https://cdn.example.com/patch.zip',
              patchSetHash: 'patch-hash',
            },
          },
          projectSlug: 'bundle-drop-app',
          platform: 'android',
        }),
      ).resolves.toBeNull();

      expect(mockReportPatchApplyFailure).toHaveBeenCalledWith('bundle-drop-app', {
        platform: 'android',
        runtimeVersion: '',
        installId: expect.any(String),
        baseHash: 'base-hash',
        targetHash: 'target-hash',
        algorithm: 'xdelta3-vcdiff',
        reason: 'patch decode failed',
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not block fallback indefinitely when patch failure telemetry hangs', async () => {
    jest.useFakeTimers();
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      mockInstallFromPatchSet.mockRejectedValueOnce(new Error('patch decode failed'));
      mockReportPatchApplyFailure.mockImplementationOnce(
        () => new Promise(() => undefined) as never,
      );

      const resultPromise = tryInstallPatchTransport({
        target: {
          mode: 'patch',
          hash: 'target-hash',
          baseHash: 'base-hash',
          patchSet: {
            algorithm: 'xdelta3-vcdiff',
            patchesUrl: 'https://cdn.example.com/patch.zip',
            patchSetHash: 'patch-hash',
          },
        },
        projectSlug: 'bundle-drop-app',
        platform: 'android',
      });

      await Promise.resolve();
      await Promise.resolve();
      jest.advanceTimersByTime(1500);
      await expect(resultPromise).resolves.toBeNull();
      expect(mockReportPatchApplyFailure).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
      warnSpy.mockRestore();
    }
  });
});
