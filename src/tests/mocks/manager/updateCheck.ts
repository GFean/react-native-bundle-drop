import type { UpdateCheckResponse } from '../../../api/types';

type CheckForUpdateResult = UpdateCheckResponse | null;

export const mockCheckForUpdate = jest.fn<
  Promise<CheckForUpdateResult>,
  [string | undefined, ((status: string) => void) | undefined]
>();

export const resetUpdateCheckMocks = () => {
  mockCheckForUpdate.mockReset();
};

export const checkForUpdate = (
  channelName?: string,
  onStatusUpdate?: (status: string) => void
) => mockCheckForUpdate(channelName, onStatusUpdate);
