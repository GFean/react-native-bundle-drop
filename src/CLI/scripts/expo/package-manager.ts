import fs from 'fs-extra';
import path from 'path';
import { spawnSync } from 'child_process';

export type SupportedPackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun';

const LOCKFILES: Record<SupportedPackageManager, string[]> = {
  npm: ['package-lock.json', 'npm-shrinkwrap.json'],
  yarn: ['yarn.lock'],
  pnpm: ['pnpm-lock.yaml'],
  bun: ['bun.lock', 'bun.lockb'],
};

export function detectPackageManager(projectRoot: string): SupportedPackageManager {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
  ) as { packageManager?: string };
  const declared = packageJson.packageManager?.split('@')[0];
  if (declared && declared in LOCKFILES) return declared as SupportedPackageManager;

  for (const manager of ['pnpm', 'yarn', 'bun', 'npm'] as const) {
    if (LOCKFILES[manager].some(lockfile => fs.existsSync(path.join(projectRoot, lockfile)))) {
      return manager;
    }
  }
  return 'npm';
}

export function expoUpdatesRemovalCommand(manager: SupportedPackageManager): string[] {
  return manager === 'npm'
    ? ['npm', 'uninstall', 'expo-updates', '--legacy-peer-deps']
    : [manager, 'remove', 'expo-updates'];
}

export type DependencyMigrationBackup = {
  projectRoot: string;
  backupDir: string;
  files: string[];
  possibleCreatedFiles: string[];
};

export function restoreDependencyMigration(backup: DependencyMigrationBackup) {
  for (const file of backup.files) {
    fs.copyFileSync(path.join(backup.backupDir, file), path.join(backup.projectRoot, file));
  }
  for (const file of backup.possibleCreatedFiles) {
    const targetPath = path.join(backup.projectRoot, file);
    if (!backup.files.includes(file) && fs.existsSync(targetPath)) {
      fs.unlinkSync(targetPath);
    }
  }
}

export function removeExpoUpdatesWithPackageManager(projectRoot: string): DependencyMigrationBackup {
  const manager = detectPackageManager(projectRoot);
  const command = expoUpdatesRemovalCommand(manager);
  const files = ['package.json', ...LOCKFILES[manager]].filter(file =>
    fs.existsSync(path.join(projectRoot, file)),
  );
  const backup: DependencyMigrationBackup = {
    projectRoot,
    backupDir: path.join(
      projectRoot,
      '.bundledrop-backup',
      `expo-updates-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    ),
    files,
    possibleCreatedFiles: LOCKFILES[manager],
  };
  for (const file of files) {
    const backupPath = path.join(backup.backupDir, file);
    fs.ensureDirSync(path.dirname(backupPath));
    fs.copyFileSync(path.join(projectRoot, file), backupPath);
  }

  const result = spawnSync(command[0], command.slice(1), {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error || result.status !== 0) {
    restoreDependencyMigration(backup);
    throw new Error(
      `Failed to remove expo-updates with ${manager}. Package files were restored; ` +
        'run your package manager install if node_modules needs repair.',
    );
  }

  const packageJson = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'),
  ) as Record<string, Record<string, unknown> | undefined>;
  const stillDeclared = [
    packageJson.dependencies,
    packageJson.devDependencies,
    packageJson.optionalDependencies,
    packageJson.peerDependencies,
  ].some(dependencies => Boolean(dependencies?.['expo-updates']));
  if (stillDeclared) {
    restoreDependencyMigration(backup);
    throw new Error(`${manager} completed but expo-updates is still declared in package.json.`);
  }

  return backup;
}
