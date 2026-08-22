import { spawnSync } from 'child_process';
import {
  createSafeBackupDirectory,
  inspectProjectFile,
  removeProjectFile,
  restoreProjectFile,
  writeBackupFile,
} from '../safe-file-transaction';

export type SupportedPackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun';

const LOCKFILES: Record<SupportedPackageManager, string[]> = {
  npm: ['package-lock.json', 'npm-shrinkwrap.json'],
  yarn: ['yarn.lock'],
  pnpm: ['pnpm-lock.yaml'],
  bun: ['bun.lock', 'bun.lockb'],
};

const inspectPackageManagerInputs = (projectRoot: string) => {
  const packageFile = inspectProjectFile(projectRoot, 'package.json');
  if (!packageFile.exists) throw new Error('package.json is required for dependency migration.');
  const lockfiles = new Set<string>();
  for (const lockfile of [...new Set(Object.values(LOCKFILES).flat())]) {
    if (inspectProjectFile(projectRoot, lockfile).exists) lockfiles.add(lockfile);
  }
  return {
    packageJson: JSON.parse(packageFile.content) as { packageManager?: string },
    lockfiles,
  };
};

export function detectPackageManager(projectRoot: string): SupportedPackageManager {
  const { packageJson, lockfiles } = inspectPackageManagerInputs(projectRoot);
  const declared = packageJson.packageManager?.split('@')[0];
  if (declared && declared in LOCKFILES) return declared as SupportedPackageManager;

  for (const manager of ['pnpm', 'yarn', 'bun', 'npm'] as const) {
    if (LOCKFILES[manager].some(lockfile => lockfiles.has(lockfile))) {
      return manager;
    }
  }
  return 'npm';
}

const dependencyRemovalCommand = (
  manager: SupportedPackageManager,
  dependency: string,
): string[] => {
  return manager === 'npm'
    ? ['npm', 'uninstall', dependency, '--legacy-peer-deps']
    : [manager, 'remove', dependency];
};

export function expoUpdatesRemovalCommand(manager: SupportedPackageManager): string[] {
  return dependencyRemovalCommand(manager, 'expo-updates');
}

export function codePushRemovalCommand(manager: SupportedPackageManager): string[] {
  return dependencyRemovalCommand(manager, 'react-native-code-push');
}

export type DependencyMigrationBackup = {
  projectRoot: string;
  backupDir: string;
  files: string[];
  possibleCreatedFiles: string[];
};

export function restoreDependencyMigration(backup: DependencyMigrationBackup) {
  for (const file of backup.files) {
    restoreProjectFile(backup.projectRoot, backup.backupDir, file);
  }
  for (const file of backup.possibleCreatedFiles) {
    if (!backup.files.includes(file)) {
      removeProjectFile(backup.projectRoot, file);
    }
  }
}

const removeDependencyWithPackageManager = (params: {
  projectRoot: string;
  dependency: string;
  backupName: string;
}): DependencyMigrationBackup => {
  const { projectRoot, dependency, backupName } = params;
  const manager = detectPackageManager(projectRoot);
  const command = dependencyRemovalCommand(manager, dependency);
  const files = ['package.json', ...LOCKFILES[manager]].filter(file =>
    inspectProjectFile(projectRoot, file).exists,
  );
  const backup: DependencyMigrationBackup = {
    projectRoot,
    backupDir: createSafeBackupDirectory(projectRoot, backupName),
    files,
    possibleCreatedFiles: LOCKFILES[manager],
  };
  for (const file of files) {
    const target = inspectProjectFile(projectRoot, file);
    if (!target.exists) throw new Error(`Package file disappeared before migration: ${file}`);
    writeBackupFile(backup.backupDir, file, target.content, target.mode);
  }

  const result = spawnSync(command[0], command.slice(1), {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error || result.status !== 0) {
    restoreDependencyMigration(backup);
    throw new Error(
      `Failed to remove ${dependency} with ${manager}. Package files were restored; ` +
        'run your package manager install if node_modules needs repair.',
    );
  }

  const migratedPackage = inspectProjectFile(projectRoot, 'package.json');
  if (!migratedPackage.exists) {
    restoreDependencyMigration(backup);
    throw new Error(`${manager} completed but package.json is missing.`);
  }
  const packageJson = JSON.parse(migratedPackage.content) as Record<
    string,
    Record<string, unknown> | undefined
  >;
  const stillDeclared = [
    packageJson.dependencies,
    packageJson.devDependencies,
    packageJson.optionalDependencies,
    packageJson.peerDependencies,
  ].some(dependencies => Boolean(dependencies?.[dependency]));
  if (stillDeclared) {
    restoreDependencyMigration(backup);
    throw new Error(`${manager} completed but ${dependency} is still declared in package.json.`);
  }

  return backup;
};

export function removeExpoUpdatesWithPackageManager(projectRoot: string): DependencyMigrationBackup {
  return removeDependencyWithPackageManager({
    projectRoot,
    dependency: 'expo-updates',
    backupName: 'expo-updates',
  });
}

export function removeCodePushWithPackageManager(projectRoot: string): DependencyMigrationBackup {
  return removeDependencyWithPackageManager({
    projectRoot,
    dependency: 'react-native-code-push',
    backupName: 'code-push',
  });
}
