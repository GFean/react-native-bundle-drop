import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { ExpoIntegrationError } from './errors';

function getProjectManifestPath(projectRoot: string): string {
  const manifestPath = path.join(path.resolve(projectRoot), 'package.json');
  if (!fs.existsSync(manifestPath)) {
    throw new ExpoIntegrationError(`No package.json was found at ${manifestPath}.`);
  }
  return manifestPath;
}

export function resolveProjectModule(projectRoot: string, moduleId: string): string {
  const projectRequire = createRequire(getProjectManifestPath(projectRoot));
  try {
    return projectRequire.resolve(moduleId);
  } catch (error) {
    throw new ExpoIntegrationError(
      `Could not resolve ${moduleId} from the Expo project at ${path.resolve(projectRoot)}. ` +
        'Install dependencies in the project and try again.',
      { cause: error },
    );
  }
}

export function loadProjectModule<T>(projectRoot: string, moduleId: string): T {
  const projectRequire = createRequire(getProjectManifestPath(projectRoot));
  const resolvedPath = resolveProjectModule(projectRoot, moduleId);
  return projectRequire(resolvedPath) as T;
}

export function resolveExpoDependency(projectRoot: string, moduleId: string): string {
  const expoManifestPath = resolveProjectModule(projectRoot, 'expo/package.json');
  const expoRequire = createRequire(expoManifestPath);
  try {
    return expoRequire.resolve(moduleId);
  } catch (error) {
    throw new ExpoIntegrationError(
      `The project-local Expo installation could not resolve ${moduleId}. ` +
        'Run the package manager used by the app and verify that its Expo SDK installation is complete.',
      { cause: error },
    );
  }
}

export function loadExpoDependency<T>(projectRoot: string, moduleId: string): T {
  const expoManifestPath = resolveProjectModule(projectRoot, 'expo/package.json');
  const expoRequire = createRequire(expoManifestPath);
  return expoRequire(resolveExpoDependency(projectRoot, moduleId)) as T;
}
