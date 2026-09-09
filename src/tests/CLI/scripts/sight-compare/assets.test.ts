import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import {
  collectComparisonAssets, writeComparisonAssetManifest,
  MAX_ASSET_MANIFEST_BYTES, MAX_COMPARISON_ASSETS_PER_SIDE,
} from '../../../../CLI/scripts/sight-compare/assets';

describe('Sight emitted asset inventory', () => {
  let root: string;
  let controller: AbortController;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sight-assets-'));
    controller = new AbortController();
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const hash = (contents: string) => createHash('sha256').update(contents).digest('hex');

  it('counts variants and duplicate bytes at distinct output paths without deduplication', async () => {
    fs.mkdirSync(path.join(root, 'assets'));
    fs.writeFileSync(path.join(root, 'assets/icon@2x.png'), 'same');
    fs.writeFileSync(path.join(root, 'assets/icon.png'), 'same');
    fs.writeFileSync(path.join(root, 'font.ttf'), 'font');
    fs.writeFileSync(path.join(root, 'empty'), '');
    expect(await collectComparisonAssets(root, controller.signal)).toEqual([
      { path: 'assets/icon.png', bytes: 4, sha256: hash('same') },
      { path: 'assets/icon@2x.png', bytes: 4, sha256: hash('same') },
      { path: 'empty', bytes: 0, sha256: hash('') },
      { path: 'font.ttf', bytes: 4, sha256: hash('font') },
    ]);
  });

  it('records an explicitly empty output and writes a deterministic manifest', async () => {
    const manifest = { version: 1 as const, metric: 'emitted-asset-bytes' as const,
      baseline: await collectComparisonAssets(root, controller.signal), current: [] };
    const filePath = path.join(root, 'comparison-assets.json');
    writeComparisonAssetManifest(filePath, manifest);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{"version":1,"metric":"emitted-asset-bytes","baseline":[],"current":[]}\n');
  });

  it('does not mistake a missing output for no assets', async () => {
    await expect(collectComparisonAssets(path.join(root, 'missing'), controller.signal)).rejects.toThrow('ENOENT');
  });

  it('rejects a symlinked root', async () => {
    fs.symlinkSync(root, path.join(root, 'link'));
    await expect(collectComparisonAssets(path.join(root, 'link'), controller.signal)).rejects.toThrow('real directory');
  });

  it.each(['file', 'directory'])('rejects emitted symlinks to a %s', async kind => {
    const target = path.join(root, 'target');
    if (kind === 'file') fs.writeFileSync(target, 'content');
    else fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(root, 'link'));
    await expect(collectComparisonAssets(root, controller.signal)).rejects.toThrow('not a regular file');
  });

  it.each(['bad\\name', 'bad\nname', 'C:icon.png', '.', '..'])('rejects ambiguous emitted paths %j', async name => {
    jest.spyOn(fs, 'readdirSync').mockReturnValue([name] as any);
    await expect(collectComparisonAssets(root, controller.signal)).rejects.toThrow('cannot represent');
  });

  it('honors cancellation before traversal', async () => {
    controller.abort(new Error('cancelled inventory'));
    await expect(collectComparisonAssets(root, controller.signal)).rejects.toThrow('cancelled inventory');
  });

  it('honors cancellation between entries', async () => {
    jest.spyOn(fs, 'readdirSync').mockImplementation(() => {
      controller.abort(new Error('cancelled traversal'));
      return ['asset.png'] as any;
    });
    await expect(collectComparisonAssets(root, controller.signal)).rejects.toThrow('cancelled traversal');
  });

  it('honors cancellation while streaming a large asset', async () => {
    fs.writeFileSync(path.join(root, 'large.bin'), Buffer.alloc(1024 * 1024));
    const original = fs.createReadStream;
    let stream: fs.ReadStream | undefined;
    jest.spyOn(fs, 'createReadStream').mockImplementation((file, options) => {
      stream = original(file, { ...options as object, highWaterMark: 1024 });
      stream.once('data', () => controller.abort());
      return stream;
    });
    await expect(collectComparisonAssets(root, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(stream?.destroyed).toBe(true);
  });

  it.each(['size', 'mtimeMs', 'ino', 'type'])('rejects an asset whose %s changes during hashing', async field => {
    const file = path.join(root, 'asset');
    fs.writeFileSync(file, 'data');
    const original = fs.lstatSync;
    let reads = 0;
    jest.spyOn(fs, 'lstatSync').mockImplementation(((target: string) => {
      const stats = original(target);
      if (target === file && ++reads > 1) {
        if (field === 'type') stats.isFile = () => false;
        else (stats as any)[field] += 1;
      }
      return stats;
    }) as any);
    await expect(collectComparisonAssets(root, controller.signal)).rejects.toThrow('changed during inventory');
  });

  it.each([-1, Number.MAX_SAFE_INTEGER + 1])('rejects invalid byte sizes %s', async size => {
    fs.writeFileSync(path.join(root, 'asset'), 'data');
    const original = fs.lstatSync;
    jest.spyOn(fs, 'lstatSync').mockImplementation(((target: string) => {
      const stats = original(target);
      if (stats.isFile()) stats.size = size;
      return stats;
    }) as any);
    await expect(collectComparisonAssets(root, controller.signal)).rejects.toThrow('supported byte range');
  });

  it('rejects aggregate byte overflow', async () => {
    fs.writeFileSync(path.join(root, 'a'), '');
    fs.writeFileSync(path.join(root, 'b'), '');
    const original = fs.lstatSync;
    jest.spyOn(fs, 'lstatSync').mockImplementation(((target: string) => {
      const stats = original(target);
      if (stats.isFile()) stats.size = Number.MAX_SAFE_INTEGER;
      return stats;
    }) as any);
    await expect(collectComparisonAssets(root, controller.signal)).rejects.toThrow('supported byte range');
  });

  function mockManyFiles(count: number, nameLength = 5) {
    const file = path.join(root, 'asset');
    fs.writeFileSync(file, '');
    const stats = fs.lstatSync(file);
    const rootStats = fs.lstatSync(root);
    jest.spyOn(fs, 'lstatSync').mockImplementation(((target: string) => target === root ? rootStats : stats) as any);
    jest.spyOn(fs, 'readdirSync').mockReturnValue(Array.from({ length: count }, (_, i) => `${i}`.padStart(nameLength, 'a')) as any);
    jest.spyOn(fs, 'createReadStream').mockImplementation(() => Readable.from([]) as any);
  }

  it('bounds entry counts per side', async () => {
    mockManyFiles(MAX_COMPARISON_ASSETS_PER_SIDE + 1);
    await expect(collectComparisonAssets(root, controller.signal)).rejects.toThrow('10000 files');
  });

  it('bounds metadata while scanning', async () => {
    mockManyFiles(5000, 1024);
    await expect(collectComparisonAssets(root, controller.signal)).rejects.toThrow('4 MiB');
  });

  it('bounds the combined manifest before writing', () => {
    const file = path.join(root, 'comparison-assets.json');
    expect(() => writeComparisonAssetManifest(file, {
      version: 1, metric: 'emitted-asset-bytes', baseline: [],
      current: [{ path: 'x'.repeat(MAX_ASSET_MANIFEST_BYTES), bytes: 0, sha256: hash('') }],
    })).toThrow('4 MiB');
    expect(fs.existsSync(file)).toBe(false);
  });
});
