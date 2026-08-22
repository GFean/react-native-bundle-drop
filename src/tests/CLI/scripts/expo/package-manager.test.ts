import fs from 'fs';
import path from 'path';

const mockSpawnSync = jest.fn();
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawnSync: (...args: unknown[]) => mockSpawnSync(...args),
}));

import {
  codePushRemovalCommand,
  detectPackageManager,
  expoUpdatesRemovalCommand,
  removeCodePushWithPackageManager,
  removeExpoUpdatesWithPackageManager,
  restoreDependencyMigration,
} from '../../../../CLI/scripts/expo/package-manager';
import * as safeFileTransaction from '../../../../CLI/scripts/safe-file-transaction';
import { createTempProjectDir, removeTempDir } from '../../../utils/tempDir';

describe('CLI/scripts/expo/package-manager', () => {
  let projectRoot = '';

  beforeEach(() => {
    projectRoot = createTempProjectDir();
    mockSpawnSync.mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    removeTempDir(projectRoot);
  });

  const writePackage = (value: Record<string, unknown>) => {
    fs.writeFileSync(path.join(projectRoot, 'package.json'), `${JSON.stringify(value, null, 2)}\n`);
  };

  it.each([
    ['npm@11.0.0', 'npm'],
    ['yarn@4.0.0', 'yarn'],
    ['pnpm@10.0.0', 'pnpm'],
    ['bun@1.2.0', 'bun'],
  ] as const)('honors a supported packageManager declaration %s', (declaration, expected) => {
    writePackage({ packageManager: declaration });
    fs.writeFileSync(path.join(projectRoot, 'pnpm-lock.yaml'), 'lock');
    expect(detectPackageManager(projectRoot)).toBe(expected);
  });

  it.each([
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
    ['package-lock.json', 'npm'],
    ['npm-shrinkwrap.json', 'npm'],
  ] as const)('detects %s as %s', (lockfile, expected) => {
    writePackage({});
    fs.writeFileSync(path.join(projectRoot, lockfile), 'lock');
    expect(detectPackageManager(projectRoot)).toBe(expected);
  });

  it('uses deterministic lockfile precedence and defaults unknown declarations to npm', () => {
    writePackage({ packageManager: 'other@1.0.0' });
    fs.writeFileSync(path.join(projectRoot, 'package-lock.json'), 'npm');
    fs.writeFileSync(path.join(projectRoot, 'yarn.lock'), 'yarn');
    fs.writeFileSync(path.join(projectRoot, 'pnpm-lock.yaml'), 'pnpm');
    expect(detectPackageManager(projectRoot)).toBe('pnpm');

    fs.unlinkSync(path.join(projectRoot, 'pnpm-lock.yaml'));
    fs.unlinkSync(path.join(projectRoot, 'yarn.lock'));
    fs.unlinkSync(path.join(projectRoot, 'package-lock.json'));
    expect(detectPackageManager(projectRoot)).toBe('npm');
  });

  it.each([
    ['npm', ['npm', 'uninstall', 'expo-updates', '--legacy-peer-deps']],
    ['yarn', ['yarn', 'remove', 'expo-updates']],
    ['pnpm', ['pnpm', 'remove', 'expo-updates']],
    ['bun', ['bun', 'remove', 'expo-updates']],
  ] as const)('builds shell-free argv for %s', (manager, expected) => {
    expect(expoUpdatesRemovalCommand(manager)).toEqual(expected);
  });

  it.each([
    ['npm', ['npm', 'uninstall', 'react-native-code-push', '--legacy-peer-deps']],
    ['yarn', ['yarn', 'remove', 'react-native-code-push']],
    ['pnpm', ['pnpm', 'remove', 'react-native-code-push']],
    ['bun', ['bun', 'remove', 'react-native-code-push']],
  ] as const)('builds shell-free CodePush removal argv for %s', (manager, expected) => {
    expect(codePushRemovalCommand(manager)).toEqual(expected);
  });

  it('backs up package files, executes exact shell-free argv, and verifies removal', () => {
    const originalPackage = {
      packageManager: 'pnpm@10.0.0',
      dependencies: { expo: '57.0.0', 'expo-updates': '1.0.0' },
    };
    writePackage(originalPackage);
    fs.writeFileSync(path.join(projectRoot, 'pnpm-lock.yaml'), 'original lock');
    mockSpawnSync.mockImplementation((_command, _args, options) => {
      const packagePath = path.join(options.cwd, 'package.json');
      const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
      delete pkg.dependencies['expo-updates'];
      fs.writeFileSync(packagePath, JSON.stringify(pkg));
      fs.writeFileSync(path.join(options.cwd, 'pnpm-lock.yaml'), 'updated lock');
      return { status: 0 };
    });

    const backup = removeExpoUpdatesWithPackageManager(projectRoot);

    expect(mockSpawnSync).toHaveBeenCalledWith(
      'pnpm',
      ['remove', 'expo-updates'],
      { cwd: projectRoot, stdio: 'inherit', shell: false },
    );
    expect(backup.files).toEqual(['package.json', 'pnpm-lock.yaml']);
    expect(backup.possibleCreatedFiles).toEqual(['pnpm-lock.yaml']);
    expect(fs.readFileSync(path.join(backup.backupDir, 'pnpm-lock.yaml'), 'utf8')).toBe(
      'original lock',
    );
    expect(JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).dependencies)
      .toEqual({ expo: '57.0.0' });

    restoreDependencyMigration(backup);
    expect(JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')))
      .toEqual(originalPackage);
    expect(fs.readFileSync(path.join(projectRoot, 'pnpm-lock.yaml'), 'utf8')).toBe('original lock');
  });

  it('removes CodePush with the detected package manager and leaves it absent for rescans', () => {
    const originalPackage = {
      packageManager: 'yarn@4.0.0',
      dependencies: {
        'react-native': '0.86.0',
        'react-native-code-push': '9.0.0',
      },
    };
    writePackage(originalPackage);
    fs.writeFileSync(path.join(projectRoot, 'yarn.lock'), 'original lock');
    mockSpawnSync.mockImplementation((_command, _args, options) => {
      const packagePath = path.join(options.cwd, 'package.json');
      const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
      delete pkg.dependencies['react-native-code-push'];
      fs.writeFileSync(packagePath, JSON.stringify(pkg));
      fs.writeFileSync(path.join(options.cwd, 'yarn.lock'), 'updated lock');
      return { status: 0 };
    });

    const backup = removeCodePushWithPackageManager(projectRoot);

    expect(mockSpawnSync).toHaveBeenCalledWith(
      'yarn',
      ['remove', 'react-native-code-push'],
      { cwd: projectRoot, stdio: 'inherit', shell: false },
    );
    expect(backup.backupDir).toContain('code-push-');
    const migratedPackage = JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
    );
    expect(migratedPackage.dependencies).toEqual({ 'react-native': '0.86.0' });
    expect(JSON.stringify(migratedPackage)).not.toContain('react-native-code-push');
  });

  it.each([
    [{ error: new Error('not found'), status: null }, 'error'],
    [{ status: 1 }, 'nonzero status'],
  ])('restores package files when command execution fails: %s', (result, _label) => {
    const original = '{"dependencies":{"expo-updates":"1.0.0"}}\n';
    fs.writeFileSync(path.join(projectRoot, 'package.json'), original);
    fs.writeFileSync(path.join(projectRoot, 'package-lock.json'), 'original lock');
    mockSpawnSync.mockImplementation(() => {
      fs.writeFileSync(path.join(projectRoot, 'package.json'), '{}');
      fs.writeFileSync(path.join(projectRoot, 'package-lock.json'), 'damaged');
      return result;
    });

    expect(() => removeExpoUpdatesWithPackageManager(projectRoot)).toThrow(
      'Package files were restored',
    );
    expect(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).toBe(original);
    expect(fs.readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8')).toBe('original lock');
  });

  it('restores backups when a successful command leaves Updates declared in any dependency group', () => {
    const original = '{"devDependencies":{"expo-updates":"1.0.0"}}\n';
    fs.writeFileSync(path.join(projectRoot, 'package.json'), original);
    mockSpawnSync.mockReturnValue({ status: 0 });

    expect(() => removeExpoUpdatesWithPackageManager(projectRoot)).toThrow(
      'expo-updates is still declared',
    );
    expect(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).toBe(original);
  });

  it('deletes a lockfile created by a failed migration while restoring original files', () => {
    const original = '{"dependencies":{"expo-updates":"1.0.0"}}\n';
    fs.writeFileSync(path.join(projectRoot, 'package.json'), original);
    mockSpawnSync.mockImplementation(() => {
      fs.writeFileSync(path.join(projectRoot, 'package.json'), '{}');
      fs.writeFileSync(path.join(projectRoot, 'package-lock.json'), '{"lockfileVersion":3}');
      return { status: 1 };
    });

    expect(() => removeExpoUpdatesWithPackageManager(projectRoot)).toThrow(
      'Package files were restored',
    );
    expect(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).toBe(original);
    expect(fs.existsSync(path.join(projectRoot, 'package-lock.json'))).toBe(false);
  });

  it('fails safely if package.json disappears before its backup is written', () => {
    writePackage({ dependencies: { 'expo-updates': '1.0.0' } });
    const realInspect = safeFileTransaction.inspectProjectFile;
    let packageInspections = 0;
    jest.spyOn(safeFileTransaction, 'inspectProjectFile').mockImplementation((root, relativePath) => {
      if (relativePath === 'package.json' && ++packageInspections === 3) {
        return { exists: false, content: '', mode: 0o666 };
      }
      return realInspect(root, relativePath);
    });

    expect(() => removeExpoUpdatesWithPackageManager(projectRoot)).toThrow(
      'Package file disappeared before migration: package.json',
    );
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it('restores the backup if a successful command removes package.json', () => {
    const original = '{"dependencies":{"expo-updates":"1.0.0"}}\n';
    fs.writeFileSync(path.join(projectRoot, 'package.json'), original);
    mockSpawnSync.mockImplementation((_command, _args, options) => {
      fs.unlinkSync(path.join(options.cwd, 'package.json'));
      return { status: 0 };
    });

    expect(() => removeExpoUpdatesWithPackageManager(projectRoot)).toThrow(
      'completed but package.json is missing',
    );
    expect(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).toBe(original);
  });

  it('checks optional and peer dependency declarations after command completion', () => {
    for (const dependencyGroup of ['optionalDependencies', 'peerDependencies']) {
      writePackage({ [dependencyGroup]: { 'expo-updates': '1.0.0' } });
      mockSpawnSync.mockReturnValueOnce({ status: 0 });
      expect(() => removeExpoUpdatesWithPackageManager(projectRoot)).toThrow(
        'expo-updates is still declared',
      );
    }
  });

  it('rejects a symlinked dependency-migration backup root without spawning', () => {
    const outsideRoot = createTempProjectDir();
    const sentinel = path.join(outsideRoot, 'sentinel.txt');
    fs.writeFileSync(sentinel, 'outside-safe');
    writePackage({ dependencies: { 'expo-updates': '1.0.0' } });
    fs.symlinkSync(outsideRoot, path.join(projectRoot, '.bundledrop-backup'));
    try {
      expect(() => removeExpoUpdatesWithPackageManager(projectRoot))
        .toThrow('symlinked or non-directory');
      expect(mockSpawnSync).not.toHaveBeenCalled();
      expect(fs.readFileSync(sentinel, 'utf8')).toBe('outside-safe');
    } finally {
      removeTempDir(outsideRoot);
    }
  });

  it('rejects symlinked package and lock files without changing external sentinels', () => {
    const outsideRoot = createTempProjectDir();
    const outsidePackage = path.join(outsideRoot, 'package.json');
    const outsideLock = path.join(outsideRoot, 'yarn.lock');
    const packageContent = JSON.stringify({
      packageManager: 'yarn@4.0.0',
      dependencies: { 'expo-updates': '1.0.0' },
    });
    fs.writeFileSync(outsidePackage, packageContent);
    fs.writeFileSync(outsideLock, 'outside-lock');
    fs.unlinkSync(path.join(projectRoot, 'package.json'));
    fs.symlinkSync(outsidePackage, path.join(projectRoot, 'package.json'));
    try {
      expect(() => removeExpoUpdatesWithPackageManager(projectRoot))
        .toThrow('symlinked or non-regular');
      expect(mockSpawnSync).not.toHaveBeenCalled();
      expect(fs.readFileSync(outsidePackage, 'utf8')).toBe(packageContent);

      fs.unlinkSync(path.join(projectRoot, 'package.json'));
      writePackage(JSON.parse(packageContent));
      fs.symlinkSync(outsideLock, path.join(projectRoot, 'yarn.lock'));
      expect(() => removeExpoUpdatesWithPackageManager(projectRoot))
        .toThrow('symlinked or non-regular');
      expect(mockSpawnSync).not.toHaveBeenCalled();
      expect(fs.readFileSync(outsideLock, 'utf8')).toBe('outside-lock');
    } finally {
      removeTempDir(outsideRoot);
    }
  });

  it('rejects a package symlink before parsing its external contents', () => {
    const outsideRoot = createTempProjectDir();
    const outsidePackage = path.join(outsideRoot, 'package.json');
    fs.writeFileSync(outsidePackage, '{malformed external json');
    fs.unlinkSync(path.join(projectRoot, 'package.json'));
    fs.symlinkSync(outsidePackage, path.join(projectRoot, 'package.json'));
    try {
      expect(() => detectPackageManager(projectRoot)).toThrow('symlinked or non-regular');
      expect(mockSpawnSync).not.toHaveBeenCalled();
      expect(fs.readFileSync(outsidePackage, 'utf8')).toBe('{malformed external json');
    } finally {
      removeTempDir(outsideRoot);
    }
  });
});
