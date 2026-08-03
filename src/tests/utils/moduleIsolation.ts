export const loadIsolatedModule = <T>(loader: () => T): T => {
  let loaded!: T;

  jest.isolateModules(() => {
    loaded = loader();
  });

  return loaded;
};
