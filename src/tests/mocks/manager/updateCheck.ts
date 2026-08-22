import type { UpdateCheckResponse } from '../../../api/types';

type CheckForUpdateResult = UpdateCheckResponse | null;

export const mockCheckForUpdate = jest.fn<
  Promise<CheckForUpdateResult>,
  [string | undefined, ((status: string) => void) | undefined]
>();

export const mockAuthorizeRuntimeDeliveryUpdate = jest.fn<
  Promise<CheckForUpdateResult>,
  [UpdateCheckResponse]
>();

export const resetUpdateCheckMocks = () => {
  mockCheckForUpdate.mockReset();
  mockAuthorizeRuntimeDeliveryUpdate.mockReset();
  mockAuthorizeRuntimeDeliveryUpdate.mockImplementation(async decision => decision);
};

export const checkForUpdate = (
  channelName?: string,
  onStatusUpdate?: (status: string) => void
) => mockCheckForUpdate(channelName, onStatusUpdate);

export const authorizeRuntimeDeliveryUpdate = (decision: UpdateCheckResponse) =>
  mockAuthorizeRuntimeDeliveryUpdate(decision);

resetUpdateCheckMocks();
