const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const androidDir = path.join(repoRoot, 'android');
const gradleCommand = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    ...options,
  });
}

function parseJavaMajor(versionOutput) {
  const match = versionOutput.match(/version "(\d+)(?:\.(\d+))?/);
  if (!match) return null;

  const first = Number(match[1]);
  const second = match[2] ? Number(match[2]) : null;
  return first === 1 && second ? second : first;
}

function javaVersionForHome(javaHome) {
  if (!javaHome) return null;
  const javaBin = path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  if (!fs.existsSync(javaBin)) return null;

  const result = run(javaBin, ['-version']);
  if (result.error || result.status !== 0) return null;
  return parseJavaMajor(`${result.stdout}\n${result.stderr}`);
}

function pathJavaVersion() {
  const result = run('java', ['-version']);
  if (result.error || result.status !== 0) return null;
  return parseJavaMajor(`${result.stdout}\n${result.stderr}`);
}

function unique(values) {
  return values.filter((value, index) => value && values.indexOf(value) === index);
}

function macJavaHome(version) {
  if (process.platform !== 'darwin') return null;
  const result = run('/usr/libexec/java_home', ['-v', String(version)]);
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function findJavaHome(options = {}) {
  const preferredMajor = options.preferredMajor || null;
  const minimumMajor = options.minimumMajor || 17;
  const exactMajor = options.exactMajor || null;
  const currentJavaMajor = javaVersionForHome(process.env.JAVA_HOME);

  if ((exactMajor || preferredMajor) && currentJavaMajor === (exactMajor || preferredMajor)) {
    return process.env.JAVA_HOME;
  }

  const preferredJavaHome = exactMajor || preferredMajor
    ? macJavaHome(exactMajor || preferredMajor)
    : null;
  if (
    preferredJavaHome
    && javaVersionForHome(preferredJavaHome) === (exactMajor || preferredMajor)
  ) {
    return preferredJavaHome;
  }

  if (exactMajor) {
    return null;
  }

  if (currentJavaMajor >= minimumMajor) {
    return process.env.JAVA_HOME;
  }

  const candidates = unique([
    macJavaHome(17),
    macJavaHome(21),
    process.env.STUDIO_JDK,
    process.env.JDK_HOME,
    process.env.JAVA17_HOME,
    process.env.JAVA_17_HOME,
    process.platform === 'darwin'
      ? '/Applications/Android Studio.app/Contents/jbr/Contents/Home'
      : null,
  ]);

  return candidates.find(candidate => javaVersionForHome(candidate) >= minimumMajor) || null;
}

function createAndroidGradleEnv(scriptName, options = {}) {
  const env = { ...process.env };
  const javaHome = findJavaHome({
    preferredMajor: options.javaMajor,
    exactMajor: options.exactJavaMajor,
    minimumMajor: options.minimumJavaMajor || options.javaMajor || 17,
  });

  if (javaHome) {
    env.JAVA_HOME = javaHome;
    env.PATH = `${path.join(javaHome, 'bin')}${path.delimiter}${env.PATH || ''}`;
  } else if (
    options.exactJavaMajor
      ? pathJavaVersion() !== options.exactJavaMajor
      : pathJavaVersion() < (options.minimumJavaMajor || options.javaMajor || 17)
  ) {
    const requiredJava = options.exactJavaMajor
      ? `Java ${options.exactJavaMajor}`
      : `Java ${options.minimumJavaMajor || options.javaMajor || 17} or newer`;
    console.error(
      [
        `Android Gradle tasks require ${requiredJava}.`,
        `Install a compatible JDK or Android Studio, then rerun \`${scriptName}\`.`,
        'You can also set JAVA_HOME to a compatible JDK path.',
      ].join('\n'),
    );
    process.exit(1);
  }

  if (!env.ANDROID_HOME && process.platform === 'darwin') {
    env.ANDROID_HOME = path.join(os.homedir(), 'Library', 'Android', 'sdk');
  }

  return env;
}

module.exports = {
  androidDir,
  createAndroidGradleEnv,
  gradleCommand,
  run,
};
