export type ModuleResolver = (
  moduleId: string,
  searchPaths: string[],
) => string;

export const resolveModuleFrom: ModuleResolver = (moduleId, searchPaths) =>
  require.resolve(moduleId, { paths: searchPaths });
