import type { BundleInfo } from '../../../bundleInfo';
import type { SupportedPatchAlgorithm } from '../../../patch-engine/patchOperations';

type InstallResult = {
  bundlePath: string;
  metadataFromZip: Partial<BundleInfo>;
};

export const mockInstallFromZip = jest.fn<
  Promise<InstallResult>,
  [
    {
      downloadUrl: string;
      hash?: string;
      platform?: 'ios' | 'android';
      statusCb?: (status: string) => void;
    },
  ]
>();

export const mockInstallFromPatchSet = jest.fn<
  Promise<InstallResult>,
  [
    {
      patchesUrl: string;
      patchSetHash: string;
      manifestUrl?: string | null;
      missingAssetsUrl?: string | null;
	      missingAssetsHash?: string | null;
	      baseHash: string;
	      targetHash: string;
	      algorithm: SupportedPatchAlgorithm;
	      platform?: 'ios' | 'android';
      statusCb?: (status: string) => void;
    },
  ]
>();

export const resetInstallFromZipMocks = () => {
  mockInstallFromZip.mockReset();
  mockInstallFromPatchSet.mockReset();
};

export const installFromZip = (
  ...args: Parameters<typeof mockInstallFromZip>
) => mockInstallFromZip(...args);

export const installFromPatchSet = (
  ...args: Parameters<typeof mockInstallFromPatchSet>
) => mockInstallFromPatchSet(...args);
