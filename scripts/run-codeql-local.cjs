'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const repositoryRoot = path.resolve(__dirname, '..');
const manifestPath = path.join(repositoryRoot, 'security', 'codeql-local.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const mode = process.argv[2];
const supportedModes = new Set(['fast', 'full', 'compare']);
const querySuiteFilenames = {
  default: {
    actions: 'actions-code-scanning.qls',
    'javascript-typescript': 'javascript-code-scanning.qls',
    'c-cpp': 'cpp-code-scanning.qls',
    swift: 'swift-code-scanning.qls',
  },
};
const threatModelArguments = {
  // CodeQL enables remote sources by default; adding local selects the same
  // remote-and-local threat model used by GitHub default setup.
  remote_and_local: ['--threat-model=local'],
};

if (!supportedModes.has(mode)) {
  throw new Error('Usage: node scripts/run-codeql-local.cjs <fast|full|compare>');
}

function validateManifestConfiguration() {
  if (manifest.schemaVersion !== 1) {
    throw new Error(`Unsupported CodeQL manifest schemaVersion: ${manifest.schemaVersion}.`);
  }

  const suiteFilenames = querySuiteFilenames[manifest.querySuite];
  if (!suiteFilenames) {
    throw new Error(`Unsupported CodeQL query suite: ${manifest.querySuite}.`);
  }
  if (!threatModelArguments[manifest.threatModel]) {
    throw new Error(`Unsupported CodeQL threat model: ${manifest.threatModel}.`);
  }

  for (const [language, configuration] of Object.entries(manifest.languages)) {
    const expectedFilename = suiteFilenames[language];
    if (!expectedFilename) {
      throw new Error(`Unsupported CodeQL language for ${manifest.querySuite}: ${language}.`);
    }
    if (path.basename(configuration.suite) !== expectedFilename) {
      throw new Error(
        `CodeQL suite for ${language} does not match ${manifest.querySuite}: ${configuration.suite}.`,
      );
    }
  }
}

validateManifestConfiguration();

const codeqlExecutable = process.env.CODEQL_BIN;
const configuredWorkDirectory = process.env.BUNDLE_DROP_CODEQL_WORKDIR;
if (!codeqlExecutable || !configuredWorkDirectory) {
  throw new Error('CODEQL_BIN and BUNDLE_DROP_CODEQL_WORKDIR are both required.');
}

const workDirectory = path.resolve(configuredWorkDirectory);
const relativeWorkDirectory = path.relative(repositoryRoot, workDirectory);
if (
  relativeWorkDirectory === '' ||
  (!relativeWorkDirectory.startsWith(`..${path.sep}`) &&
    relativeWorkDirectory !== '..' &&
    !path.isAbsolute(relativeWorkDirectory))
) {
  throw new Error('BUNDLE_DROP_CODEQL_WORKDIR must be outside the repository.');
}

const runDirectory = path.join(workDirectory, 'current');
const sourceDirectory = path.join(runDirectory, 'source');
const resultsDirectory = path.join(runDirectory, 'results');

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    shell: false,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${path.basename(executable)} exited with status ${result.status}`);
  }
  return result;
}

function verifyCodeqlVersion() {
  const result = run(codeqlExecutable, ['version', '--format=json'], {
    capture: true,
  });
  const version = JSON.parse(result.stdout).version;
  if (version !== manifest.codeqlVersion) {
    throw new Error(`Expected CodeQL ${manifest.codeqlVersion}, received ${version}.`);
  }
}

function resetRunDirectory() {
  const relativeRunDirectory = path.relative(workDirectory, runDirectory);
  if (relativeRunDirectory !== 'current') {
    throw new Error('Refusing to clear an unexpected CodeQL run directory.');
  }
  fs.rmSync(runDirectory, { recursive: true, force: true });
  fs.mkdirSync(sourceDirectory, { recursive: true });
  fs.mkdirSync(resultsDirectory, { recursive: true });
}

function trackedSourceFiles() {
  const result = run(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { capture: true },
  );
  return result.stdout.split('\0').filter(Boolean);
}

function copySourceSnapshot() {
  for (const relativePath of trackedSourceFiles()) {
    const sourcePath = path.resolve(repositoryRoot, relativePath);
    const destinationPath = path.resolve(sourceDirectory, relativePath);
    if (
      !sourcePath.startsWith(`${repositoryRoot}${path.sep}`) ||
      !destinationPath.startsWith(`${sourceDirectory}${path.sep}`)
    ) {
      throw new Error(`Refusing to copy an unsafe repository path: ${relativePath}`);
    }
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    const stat = fs.lstatSync(sourcePath);
    if (stat.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(sourcePath), destinationPath);
    } else if (stat.isFile()) {
      fs.copyFileSync(sourcePath, destinationPath);
    }
  }
}

function scanLanguage(language) {
  const configuration = manifest.languages[language];
  const databasePath = path.join(runDirectory, `${language}-database`);
  const sarifPath = path.join(resultsDirectory, `${language}.sarif`);
  const codeqlRoot = path.dirname(fs.realpathSync(codeqlExecutable));
  const suitePath = path.join(codeqlRoot, configuration.suite);
  if (!fs.existsSync(suitePath)) {
    throw new Error(`The pinned ${language} query suite is missing: ${suitePath}`);
  }

  run(codeqlExecutable, [
    'database',
    'create',
    databasePath,
    `--language=${language}`,
    `--source-root=${sourceDirectory}`,
    `--build-mode=${configuration.buildMode}`,
    '--overwrite',
  ]);
  run(codeqlExecutable, [
    'database',
    'analyze',
    databasePath,
    suitePath,
    '--format=sarifv2.1.0',
    `--output=${sarifPath}`,
    `--sarif-category=/language:${language}`,
    '--threads=0',
    ...threatModelArguments[manifest.threatModel],
  ]);
}

function normalizeFinding(language, result) {
  const location = result.locations?.[0]?.physicalLocation;
  const message = result.message?.text || '';
  return {
    language,
    ruleId: result.ruleId,
    path: location?.artifactLocation?.uri,
    line: location?.region?.startLine,
    messageSha256: crypto.createHash('sha256').update(message).digest('hex'),
  };
}

function findingKey(finding) {
  return JSON.stringify([
    finding.language,
    finding.ruleId,
    finding.path,
    finding.line,
    finding.messageSha256,
  ]);
}

function countFindings(findings) {
  const counts = new Map();
  for (const finding of findings) {
    const key = findingKey(finding);
    counts.set(key, (counts.get(key) || 0) + (finding.count || 1));
  }
  return counts;
}

function findingFromKey(key, count) {
  const [language, ruleId, findingPath, line, messageSha256] = JSON.parse(key);
  return { language, ruleId, path: findingPath, line, messageSha256, count };
}

function compareResults() {
  if (!fs.existsSync(resultsDirectory)) {
    throw new Error('No local CodeQL results exist. Run the fast or full gate first.');
  }
  const resultFiles = fs.readdirSync(resultsDirectory).filter(file => file.endsWith('.sarif'));
  const scannedLanguages = new Set();
  const actualFindings = [];
  for (const resultFile of resultFiles) {
    const language = resultFile.replace(/\.sarif$/, '');
    scannedLanguages.add(language);
    const sarif = JSON.parse(fs.readFileSync(path.join(resultsDirectory, resultFile), 'utf8'));
    for (const runResult of sarif.runs || []) {
      for (const result of runResult.results || []) {
        actualFindings.push(normalizeFinding(language, result));
      }
    }
  }

  const expectedFindings = manifest.acceptedFindings.filter(finding =>
    scannedLanguages.has(finding.language),
  );
  const actualCounts = countFindings(actualFindings);
  const expectedCounts = countFindings(expectedFindings);
  const unexpected = [];
  const stale = [];
  for (const [key, count] of actualCounts) {
    const excess = count - (expectedCounts.get(key) || 0);
    if (excess > 0) unexpected.push(findingFromKey(key, excess));
  }
  for (const [key, count] of expectedCounts) {
    const missing = count - (actualCounts.get(key) || 0);
    if (missing > 0) stale.push(findingFromKey(key, missing));
  }
  if (unexpected.length || stale.length) {
    console.error(JSON.stringify({ unexpected, stale }, null, 2));
    throw new Error(
      `CodeQL comparison failed: ${unexpected.length} unexpected and ${stale.length} stale accepted findings.`,
    );
  }
  console.log(`CodeQL comparison passed with ${actualFindings.length} reviewed findings.`);
}

verifyCodeqlVersion();
if (mode === 'compare') {
  compareResults();
  process.exit(0);
}

resetRunDirectory();
copySourceSnapshot();
const languages = mode === 'fast'
  ? ['javascript-typescript', 'c-cpp']
  : ['actions', 'javascript-typescript', 'c-cpp', 'swift'];
for (const language of languages) scanLanguage(language);
compareResults();
