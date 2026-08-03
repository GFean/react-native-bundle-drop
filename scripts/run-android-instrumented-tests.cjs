#!/usr/bin/env node

const {
  androidDir,
  createAndroidGradleEnv,
  gradleCommand,
  run,
} = require('./android-gradle-env.cjs');

const result = run(
  gradleCommand,
  ['connectedDebugAndroidTest', '-Pstandalone', '--quiet'],
  {
    cwd: androidDir,
    env: createAndroidGradleEnv('corepack yarn test:android:device'),
    stdio: 'inherit',
  },
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
