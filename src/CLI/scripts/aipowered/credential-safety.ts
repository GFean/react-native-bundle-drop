const BUNDLE_DROP_PROJECT_KEY = /\bbdp_proj_[A-Za-z0-9_-]{32,}\b/;
const BUNDLE_DROP_PERSONAL_ACCESS_TOKEN = /\bbdp_pat_[A-Za-z0-9_-]{32,}\b/;

export const findKnownBundleDropCredential = (value: string): string | null => {
  if (BUNDLE_DROP_PROJECT_KEY.test(value)) return 'Bundle Drop project key';
  if (BUNDLE_DROP_PERSONAL_ACCESS_TOKEN.test(value)) {
    return 'Bundle Drop personal access token';
  }
  return null;
};
