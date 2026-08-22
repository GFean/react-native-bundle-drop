#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const COVERAGE_PATH = path.join(process.cwd(), 'coverage', 'coverage-final.json');

const DEFAULT_THRESHOLDS = {
  statements: 100,
  branches: 95,
  functions: 100,
  lines: 100,
};

const FILE_THRESHOLDS = {
  // Large parser/orchestration modules retain explicit per-file floors. Their
  // fail-closed grammar and filesystem race branches are not all practical to
  // execute portably, but these floors prevent coverage from silently falling
  // below the reviewed baseline. All other files keep the 100/95 defaults.
  'src/CLI/cli.ts': { statements: 98, branches: 93, functions: 100, lines: 98 },
  'src/CLI/scripts/aipowered/code-push-residue.ts': {
    statements: 97,
    branches: 90,
    functions: 100,
    lines: 97,
  },
  'src/CLI/scripts/aipowered/init-project-config.ts': {
    statements: 98,
    branches: 95,
    functions: 100,
    lines: 98,
  },
  'src/CLI/scripts/aipowered/scanner.ts': {
    statements: 97,
    branches: 93,
    functions: 100,
    lines: 97,
  },
  'src/CLI/scripts/aipowered/validate-plan.ts': {
    statements: 90,
    branches: 84,
    functions: 94,
    lines: 90,
  },
  'src/CLI/scripts/doctor.ts': { statements: 99, branches: 98, functions: 100, lines: 99 },
  'src/CLI/scripts/expo/configure-expo.ts': {
    statements: 99,
    branches: 98,
    functions: 100,
    lines: 99,
  },
  'src/CLI/scripts/expo/package-manager.ts': {
    statements: 93,
    branches: 80,
    functions: 100,
    lines: 93,
  },
  'src/CLI/scripts/metro-config-authority.ts': {
    statements: 93,
    branches: 77,
    functions: 100,
    lines: 93,
  },
  'src/CLI/scripts/native-entrypoint-authority.ts': {
    statements: 91,
    branches: 85,
    functions: 100,
    lines: 91,
  },
  'src/CLI/scripts/native-setup-contract.ts': {
    statements: 95,
    branches: 89,
    functions: 100,
    lines: 95,
  },
  'src/CLI/scripts/native-startup-validator.ts': {
    statements: 93,
    branches: 79,
    functions: 99,
    lines: 93,
  },
  'src/CLI/scripts/safe-file-transaction.ts': {
    statements: 98,
    branches: 96,
    functions: 100,
    lines: 98,
  },
  'src/CLI/scripts/login-cli.ts': { statements: 99, branches: 83, functions: 96, lines: 99 },
  'src/CLI/scripts/upload-cli.ts': { statements: 100, branches: 91, functions: 100, lines: 100 },
  'src/injectImageResolver.ts': { statements: 98, branches: 90, functions: 100, lines: 98 },
  'src/manager/updateState.ts': { statements: 100, branches: 92, functions: 100, lines: 100 },
  'src/scripts/bundle.ts': { statements: 99, branches: 83, functions: 100, lines: 99 },
  'src/scripts/download-bundle.ts': { statements: 97, branches: 96, functions: 100, lines: 97 },
};

if (!fs.existsSync(COVERAGE_PATH)) {
  console.error(`Coverage report not found at ${COVERAGE_PATH}. Run "yarn test:coverage" first.`);
  process.exit(1);
}

const coverage = JSON.parse(fs.readFileSync(COVERAGE_PATH, 'utf8'));

const toPosix = value => value.split(path.sep).join('/');

const getPercent = counters => {
  let total = 0;
  let covered = 0;

  for (const value of Object.values(counters)) {
    if (Array.isArray(value)) {
      total += value.length;
      covered += value.filter(count => count > 0).length;
      continue;
    }

    total += 1;
    if (value > 0) {
      covered += 1;
    }
  }

  if (total === 0) {
    return 100;
  }

  return (covered / total) * 100;
};

const getMetrics = entry => ({
  statements: getPercent(entry.s),
  branches: getPercent(entry.b),
  functions: getPercent(entry.f),
  lines: getPercent(entry.l || entry.s),
});

const formatPercent = value => value.toFixed(2);

const failures = [];
const files = Object.keys(coverage)
  .map(filePath => toPosix(path.relative(process.cwd(), filePath)))
  .sort();

for (const file of files) {
  const absolutePath = path.join(process.cwd(), file);
  const entry = coverage[absolutePath];
  const actual = getMetrics(entry);
  const expected = {
    ...DEFAULT_THRESHOLDS,
    ...(FILE_THRESHOLDS[file] || {}),
  };

  for (const metric of Object.keys(expected)) {
    if (actual[metric] + Number.EPSILON < expected[metric]) {
      failures.push({
        file,
        metric,
        actual: formatPercent(actual[metric]),
        expected: formatPercent(expected[metric]),
      });
    }
  }
}

if (failures.length > 0) {
  console.error('Coverage thresholds failed:');
  for (const failure of failures) {
    console.error(
      `  ${failure.file} ${failure.metric}: ${failure.actual}% < ${failure.expected}%`,
    );
  }
  process.exit(1);
}

console.log(`Coverage thresholds satisfied for ${files.length} files.`);
