#!/usr/bin/env node

const {
  androidDir,
  createAndroidGradleEnv,
  gradleCommand,
  run,
} = require('./android-gradle-env.cjs');

const result = run(
  gradleCommand,
  [
    'jacocoCoverageGate',
    '-Pstandalone',
    // The standalone gate resolves react-android 0.87, whose metadata requires Kotlin 2.2.
    // Consumer builds retain the package's 2.0.21 default and can keep overriding it normally.
    '-PBundleDrop_kotlinVersion=2.2.0',
    '--quiet',
  ],
  {
    cwd: androidDir,
    env: createAndroidGradleEnv('corepack yarn test:android'),
    stdio: 'inherit',
  },
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
