export const imageManifest: Record<string, string> = {};

export const resetImageManifestMock = () => {
  Object.keys(imageManifest).forEach(key => {
    delete imageManifest[key];
  });
};
