import RNFS from '../native/fs';
import { BUNDLE_DROP_ROOT, config } from '../context';
import { ensureDir } from './fsUtils';

export const MAX_REPORTED_INSTALL_HASHES = 50;

type InstalledReportHistory = {
  scope: string;
  hashes: string[];
};

// Serialize read/merge/write so simultaneous reports for different hashes cannot
// overwrite one another. This file outlives disposable current-bundle metadata.
let pendingWrite: Promise<unknown> = Promise.resolve();

export function mergeInstalledReportHistory(
  installId: string,
  legacyHashes: string[],
  reportedHash?: string,
): Promise<string[]> {
  const path = `${BUNDLE_DROP_ROOT}/installed-report-history.json`;
  const scope = JSON.stringify([config.serverUrl, config.org.slug, config.project.slug, installId]);
  const operation = pendingWrite.then(async () => {
    let existing: InstalledReportHistory | null | undefined;
    if (await RNFS.exists(path)) {
      const contents = await RNFS.readFile(path, 'utf8');
      try {
        existing = JSON.parse(contents);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        existing = null;
      }
      if (typeof existing?.scope !== 'string' || !Array.isArray(existing.hashes)
        || existing.hashes.some(hash => typeof hash !== 'string')) {
        existing = null;
      }
    }
    // Legacy metadata has no scope. Migrate it only when creating the ledger,
    // never after a known installation/project change.
    const sameScope = existing?.scope === scope;
    const hashes = [...new Set([
      ...(sameScope ? existing.hashes : []),
      ...(existing === undefined ? legacyHashes : []),
    ])];
    if (reportedHash) {
      const previous = hashes.indexOf(reportedHash);
      if (previous !== -1) hashes.splice(previous, 1);
      hashes.push(reportedHash);
    }
    const bounded = hashes.slice(-MAX_REPORTED_INSTALL_HASHES);
    if (!sameScope || JSON.stringify(existing.hashes) !== JSON.stringify(bounded)) {
      await ensureDir(BUNDLE_DROP_ROOT);
      await RNFS.writeFile(path, JSON.stringify({ scope, hashes: bounded }), 'utf8');
    }
    return bounded;
  });
  pendingWrite = operation.catch(() => {});
  return operation;
}
