export const mockAxiosNodeGet = jest.fn();
export const mockAxiosNodePost = jest.fn();
export const mockAxiosNodeIsAxiosError = jest.fn((error: unknown) => Boolean((error as { isAxiosError?: boolean })?.isAxiosError));

export const resetAxiosNodeMocks = () => {
  mockAxiosNodeGet.mockReset();
  mockAxiosNodePost.mockReset();
  mockAxiosNodeIsAxiosError.mockReset().mockImplementation(
    (error: unknown) => Boolean((error as { isAxiosError?: boolean })?.isAxiosError)
  );
};

const axiosModule = {
  get: (...args: Parameters<typeof mockAxiosNodeGet>) => mockAxiosNodeGet(...args),
  post: (...args: Parameters<typeof mockAxiosNodePost>) => mockAxiosNodePost(...args),
  isAxiosError: (...args: Parameters<typeof mockAxiosNodeIsAxiosError>) =>
    mockAxiosNodeIsAxiosError(...args),
};

export default axiosModule;
