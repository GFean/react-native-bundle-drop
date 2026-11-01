import { createRequire } from 'node:module';
import path from 'node:path';

export const getOriginalEnv = () => ({ ...process.env });
export const setNodeEnv = (mode: string, options: { systemEnv: NodeJS.ProcessEnv }) => ({
  ...options.systemEnv, NODE_ENV: mode,
});

export function loadProjectEnv(projectRoot: string, options: { mode: string }): void {
  process.env.NODE_ENV = options.mode;
  const projectRequire = createRequire(path.join(projectRoot, 'package.json'));
  const expoRequire = createRequire(projectRequire.resolve('expo/package.json'));
  const env = expoRequire('@expo/env');
  // The app owns its supported Expo environment loader, including dotenv rules.
  if (typeof env.loadProjectEnv === 'function') env.loadProjectEnv(projectRoot, options);
  else if (typeof env.load === 'function') env.load(projectRoot);
  else throw new Error('The project-local Expo environment loader is unavailable.');
}
