export const BUNDLE_MANIFEST = 'bundle-manifest.json';

export type BundleManifestFileRole =
  | 'jsbundle'
  | 'metadata'
  | 'asset'
  | 'androidImageManifest';

export type BundleManifestFile = {
  path: string;
  size: number;
  sha256: string;
  role: BundleManifestFileRole;
  executable?: boolean;
};

export type BundleManifest = {
  manifestVersion: 1;
  bundleHash: string;
  jsBundleHash: string;
  platform: 'ios' | 'android' | string;
  runtimeVersion: string;
  version: string;
  manifestHash: string;
  files: BundleManifestFile[];
};

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const utf8ToBytes = (value: string): number[] => {
  const encoded = encodeURIComponent(value);
  const bytes: number[] = [];
  for (let i = 0; i < encoded.length; i += 1) {
    if (encoded[i] === '%') {
      bytes.push(parseInt(encoded.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(encoded.charCodeAt(i));
    }
  }
  return bytes;
};

export const byteLengthFromBase64 = (value: string): number => {
  const clean = value.replace(/\s+/g, '');
  if (!clean) return 0;
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.floor((clean.length * 3) / 4) - padding;
};

export const base64ToBytes = (value: string): number[] => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = value.replace(/\s+/g, '');
  const bytes: number[] = [];

  for (let i = 0; i < clean.length; i += 4) {
    const c1 = chars.indexOf(clean[i]);
    const c2 = chars.indexOf(clean[i + 1]);
    const c3 = clean[i + 2] === '=' ? -1 : chars.indexOf(clean[i + 2]);
    const c4 = clean[i + 3] === '=' ? -1 : chars.indexOf(clean[i + 3]);
    if (c1 < 0 || c2 < 0 || (clean[i + 2] !== '=' && c3 < 0) || (clean[i + 3] !== '=' && c4 < 0)) {
      throw new Error('Invalid base64 data');
    }
    const n = (c1 << 18) | (c2 << 12) | ((c3 < 0 ? 0 : c3) << 6) | (c4 < 0 ? 0 : c4);
    bytes.push((n >> 16) & 0xff);
    if (c3 >= 0) bytes.push((n >> 8) & 0xff);
    if (c4 >= 0) bytes.push(n & 0xff);
  }

  return bytes;
};

export const sha256Bytes = (input: number[] | Uint8Array): string => {
  const bytes = Array.from(input);
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while ((bytes.length % 64) !== 56) bytes.push(0);
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  bytes.push((high >>> 24) & 0xff, (high >>> 16) & 0xff, (high >>> 8) & 0xff, high & 0xff);
  bytes.push((low >>> 24) & 0xff, (low >>> 16) & 0xff, (low >>> 8) & 0xff, low & 0xff);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const w = new Array<number>(64);

  for (let i = 0; i < bytes.length; i += 64) {
    for (let t = 0; t < 16; t += 1) {
      const j = i + t * 4;
      w[t] = ((bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3]) >>> 0;
    }
    for (let t = 16; t < 64; t += 1) {
      const s0 = (rightRotate(w[t - 15], 7) ^ rightRotate(w[t - 15], 18) ^ (w[t - 15] >>> 3)) >>> 0;
      const s1 = (rightRotate(w[t - 2], 17) ^ rightRotate(w[t - 2], 19) ^ (w[t - 2] >>> 10)) >>> 0;
      w[t] = (((w[t - 16] + s0) >>> 0) + ((w[t - 7] + s1) >>> 0)) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let t = 0; t < 64; t += 1) {
      const s1 = (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (((((h + s1) >>> 0) + ch) >>> 0) + ((K[t] + w[t]) >>> 0)) >>> 0;
      const s0 = (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (s0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map(value => value.toString(16).padStart(8, '0'))
    .join('');
};

const rightRotate = (value: number, bits: number) =>
  ((value >>> bits) | (value << (32 - bits))) >>> 0;

export const sha256String = (value: string): string => sha256Bytes(utf8ToBytes(value));

export const sha256Base64 = (value: string): string => sha256Bytes(base64ToBytes(value));

const metadataPathForPlatform = (platform: string) => `metadata-${platform}.json`;

export const normalizeManifestPath = (value: string): string => {
  if (typeof value !== 'string') {
    throw new Error('Manifest path must be a string');
  }
  if (value !== value.trim()) {
    throw new Error(`Invalid manifest path: ${value}`);
  }
  if (!value || value.includes('\0') || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) {
    throw new Error(`Invalid manifest path: ${value}`);
  }
  const normalized = value;
  if (!normalized || normalized.split('/').some(segment => !segment || segment === '..' || segment === '.')) {
    throw new Error(`Invalid manifest path: ${value}`);
  }
  return normalized;
};

export const sortManifestFiles = (files: BundleManifestFile[]): BundleManifestFile[] =>
  [...files]
    .map(file => ({
      ...file,
      path: normalizeManifestPath(file.path),
      executable: file.executable || undefined,
    }))
    .sort((a, b) => compareUtf8(a.path, b.path));

const compareUtf8 = (left: string, right: string) => {
  const leftBytes = utf8ToBytes(left);
  const rightBytes = utf8ToBytes(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let i = 0; i < length; i += 1) {
    if (leftBytes[i] !== rightBytes[i]) {
      return leftBytes[i] - rightBytes[i];
    }
  }
  return leftBytes.length - rightBytes.length;
};

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => compareUtf8(left, right));
    return `{${entries
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

export const canonicalManifestFileEntries = (files: BundleManifestFile[]) =>
  sortManifestFiles(files).map(file => {
    const entry: Record<string, unknown> = {
      path: file.path,
      role: file.role,
      size: file.size,
      sha256: file.sha256,
    };
    if (file.executable) {
      entry.executable = true;
    }
    return entry;
  });

export const calculateBundleHash = (files: BundleManifestFile[]): string =>
  sha256String(stableStringify({
    manifestVersion: 1,
    files: canonicalManifestFileEntries(files),
  }));

export const calculateManifestHash = (manifest: Omit<BundleManifest, 'manifestHash'>): string =>
  sha256String(stableStringify({
    manifestVersion: 1,
    bundleHash: manifest.bundleHash,
    jsBundleHash: manifest.jsBundleHash,
    platform: manifest.platform,
    runtimeVersion: manifest.runtimeVersion,
    version: manifest.version,
    files: sortManifestFiles(manifest.files),
  }));

export const createBundleManifest = (
  input: Omit<BundleManifest, 'manifestVersion' | 'manifestHash' | 'files'> & {
    files: BundleManifestFile[];
  },
): BundleManifest => {
  const files = sortManifestFiles(input.files);
  const manifestWithoutHash: Omit<BundleManifest, 'manifestHash'> = {
    manifestVersion: 1,
    bundleHash: input.bundleHash,
    jsBundleHash: input.jsBundleHash,
    platform: input.platform,
    runtimeVersion: input.runtimeVersion,
    version: input.version,
    files,
  };
  return {
    ...manifestWithoutHash,
    manifestHash: calculateManifestHash(manifestWithoutHash),
  };
};

export const assertValidBundleManifest = (
  manifest: BundleManifest,
  expectedBundleHash?: string,
  expectedPlatform?: 'ios' | 'android',
): void => {
  if (manifest?.manifestVersion !== 1) {
    throw new Error('Invalid bundle manifest version');
  }
  if (!manifest.bundleHash) {
    throw new Error('Bundle manifest is missing bundleHash');
  }
  if (!manifest.runtimeVersion) {
    throw new Error('Bundle manifest is missing runtimeVersion');
  }
  if (!manifest.version) {
    throw new Error('Bundle manifest is missing version');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('Bundle manifest must include files');
  }
  const paths = new Set<string>();
  for (const file of manifest.files) {
    const normalizedPath = normalizeManifestPath(file.path);
    if (paths.has(normalizedPath)) {
      throw new Error(`Duplicate manifest file path: ${normalizedPath}`);
    }
    paths.add(normalizedPath);
  }
  const jsBundleFiles = manifest.files.filter(file => file.role === 'jsbundle');
  if (jsBundleFiles.length !== 1 || normalizeManifestPath(jsBundleFiles[0].path) !== 'main.jsbundle') {
    throw new Error('Bundle manifest must include exactly one main.jsbundle file');
  }
  if (jsBundleFiles[0].sha256 !== manifest.jsBundleHash) {
    throw new Error('jsBundleHash does not match manifest jsbundle file');
  }
  if (manifest.platform !== 'ios' && manifest.platform !== 'android') {
    throw new Error('Bundle manifest platform must be ios or android');
  }
  if (expectedPlatform && manifest.platform !== expectedPlatform) {
    throw new Error(`Bundle manifest platform mismatch: expected ${expectedPlatform}, got ${manifest.platform}`);
  }
  const metadataFiles = manifest.files.filter(file => file.role === 'metadata');
  if (
    metadataFiles.length !== 1 ||
    normalizeManifestPath(metadataFiles[0].path) !== metadataPathForPlatform(manifest.platform)
  ) {
    throw new Error(`Bundle manifest must include exactly one ${metadataPathForPlatform(manifest.platform)} metadata file`);
  }
  const androidImageManifests = manifest.files.filter(file => file.role === 'androidImageManifest');
  if (manifest.platform === 'android') {
    if (
      androidImageManifests.length !== 1 ||
      normalizeManifestPath(androidImageManifests[0].path) !== 'image-manifest.json'
    ) {
      throw new Error('Android bundle manifest must include image-manifest.json');
    }
  } else if (androidImageManifests.length > 0) {
    throw new Error('iOS bundle manifest must not include Android image-manifest.json');
  }
  if (expectedBundleHash && manifest.bundleHash !== expectedBundleHash) {
    throw new Error(`Bundle manifest hash mismatch: expected ${expectedBundleHash}, got ${manifest.bundleHash}`);
  }
  const calculatedBundleHash = calculateBundleHash(manifest.files);
  if (calculatedBundleHash !== manifest.bundleHash) {
    throw new Error(`Bundle hash verification failed: expected ${manifest.bundleHash}, got ${calculatedBundleHash}`);
  }
  if (!manifest.manifestHash) {
    throw new Error('Bundle manifest is missing manifestHash');
  }
  if (!/^[a-f0-9]{64}$/.test(manifest.manifestHash)) {
    throw new Error('Bundle manifest has invalid manifestHash');
  }
  const { manifestHash: _manifestHash, ...manifestWithoutHash } = manifest;
  const calculatedManifestHash = calculateManifestHash(manifestWithoutHash);
  if (calculatedManifestHash !== manifest.manifestHash) {
    throw new Error('Bundle manifest hash verification failed');
  }
};
