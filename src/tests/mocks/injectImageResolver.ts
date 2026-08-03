export const mockInjectBundleDropImageResolver = jest.fn();

export const resetInjectImageResolverMocks = () => {
  mockInjectBundleDropImageResolver.mockReset();
};

export const injectBundleDropImageResolver = (
  ...args: Parameters<typeof mockInjectBundleDropImageResolver>
) => mockInjectBundleDropImageResolver(...args);
