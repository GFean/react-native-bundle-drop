export const mockGetDownloadedBundlePathNative = jest.fn<Promise<string | null>, []>();
export const mockRestartReactNativeNative = jest.fn<void, []>();
export const mockActivateStartupCandidateNative = jest.fn<Promise<any>, [string, unknown]>();
export const mockMarkStartupHealthyNative = jest.fn<Promise<boolean>, [unknown]>();
export const mockGetStartupRecoveryStateNative = jest.fn<Promise<unknown>, []>();
export const mockSetStartupRecoveryRevokedHashesNative = jest.fn<Promise<boolean>, [string[]]>();
export const mockAcknowledgeStartupRecoveryNative = jest.fn<Promise<boolean>, [string]>();
export const mockRollbackStartupBundleNative = jest.fn<Promise<any>, [boolean]>();
export const mockGetStartupRecoveryAttemptNative = jest.fn<unknown, []>();
export const mockGetStartupRecoverySelectedHashNative = jest.fn<string | null | undefined, []>();

export const resetBundleDropNativeMocks = () => {
  mockGetDownloadedBundlePathNative.mockReset();
  mockGetDownloadedBundlePathNative.mockResolvedValue(null);
  mockRestartReactNativeNative.mockReset();
  mockActivateStartupCandidateNative.mockReset();
  mockActivateStartupCandidateNative.mockImplementation(async hash => ({
    hash,
    bundlePath: `/mock/doc/bundle-drop/bundles/${hash}/main.jsbundle`,
  }));
  mockMarkStartupHealthyNative.mockReset();
  mockMarkStartupHealthyNative.mockResolvedValue(true);
  mockGetStartupRecoveryStateNative.mockReset();
  mockGetStartupRecoveryStateNative.mockResolvedValue({
    protocolVersion: 1,
    revision: 0,
    phase: 'idle',
    quarantinedHashes: [],
    pendingRecoveryEvents: [],
  });
  mockSetStartupRecoveryRevokedHashesNative.mockReset();
  mockSetStartupRecoveryRevokedHashesNative.mockResolvedValue(true);
  mockAcknowledgeStartupRecoveryNative.mockReset();
  mockAcknowledgeStartupRecoveryNative.mockResolvedValue(true);
  mockRollbackStartupBundleNative.mockReset();
  mockRollbackStartupBundleNative.mockResolvedValue({
    rolledBack: true,
    toEmbedded: false,
    hash: 'c'.repeat(64),
  });
  mockGetStartupRecoveryAttemptNative.mockReset();
  mockGetStartupRecoveryAttemptNative.mockReturnValue(null);
  mockGetStartupRecoverySelectedHashNative.mockReset();
  mockGetStartupRecoverySelectedHashNative.mockReturnValue(undefined);
};

resetBundleDropNativeMocks();

export const getDownloadedBundlePathNative = () => mockGetDownloadedBundlePathNative();

export const restartReactNativeNative = () => mockRestartReactNativeNative();
export const activateStartupCandidateNative = (hash: string, policy: unknown) =>
  mockActivateStartupCandidateNative(hash, policy);
export const markStartupHealthyNative = (attempt: unknown) => mockMarkStartupHealthyNative(attempt);
export const getStartupRecoveryStateNative = () => mockGetStartupRecoveryStateNative();
export const setStartupRecoveryRevokedHashesNative = (hashes: string[]) =>
  mockSetStartupRecoveryRevokedHashesNative(hashes);
export const acknowledgeStartupRecoveryNative = (eventId: string) =>
  mockAcknowledgeStartupRecoveryNative(eventId);
export const rollbackStartupBundleNative = (forceEmbedded: boolean) =>
  mockRollbackStartupBundleNative(forceEmbedded);
export const getStartupRecoveryAttemptNative = () => mockGetStartupRecoveryAttemptNative();
export const getStartupRecoverySelectedHashNative = () => mockGetStartupRecoverySelectedHashNative();
