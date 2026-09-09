import fs from 'fs';
import os from 'os';
import path from 'path';

const { checkCliIsolation } = require('../../../scripts/check-cli-isolation.cjs') as {
  checkCliIsolation(root: string, entries: string[]): string[];
};

describe('Sight mobile import boundary', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'sight-import-boundary-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
  const write = (root: string, name: string, source: string) => {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), source);
  };

  it('follows emitted imports and reports the chain to comparison code', () => {
    write(root, 'lib/index.js', 'require("./runtime");');
    write(root, 'lib/runtime.js', 'require("./CLI/scripts/sight-compare/run");');
    write(root, 'lib/CLI/scripts/sight-compare/run.js', 'module.exports = {};');
    expect(() => checkCliIsolation(root, ['lib/index.js'])).toThrow('lib/index.js -> lib/runtime.js -> lib/CLI/scripts/sight-compare/run.js');
  });

  it.each(['assets', 'ota'])('rejects direct %s helpers even without downstream imports', helper => {
    write(root, 'lib/index.js', `require("./CLI/scripts/sight-${helper}");`);
    write(root, `lib/CLI/scripts/sight-${helper}.js`, 'module.exports = {};');
    expect(() => checkCliIsolation(root, ['lib/index.js'])).toThrow(`sight-${helper}.js`);
  });

  it('also rejects comparison leakage through declarations or source re-exports', () => {
    write(root, 'lib/index.d.ts', 'export type {Options} from "./CLI/scripts/sight-compare/types";');
    write(root, 'lib/CLI/scripts/sight-compare/types.d.ts', 'export type Options = {};');
    expect(() => checkCliIsolation(root, ['lib/index.d.ts'])).toThrow('Sight CLI code is reachable');
    write(root, 'src/index.tsx', 'export {run} from "./CLI/scripts/sight-compare/run";');
    write(root, 'src/CLI/scripts/sight-compare/run.ts', 'export function run() {}');
    expect(() => checkCliIsolation(root, ['src/index.tsx'])).toThrow('Sight CLI code is reachable');
  });

  it('accepts an SDK graph with cycles and unrelated build-time helpers', () => {
    write(root, 'lib/index.js', 'require("./runtime"); require("react-native");');
    write(root, 'lib/runtime.js', 'require("./index");');
    expect(checkCliIsolation(root, ['lib/index.js'])).toEqual(['lib/index.js', 'lib/runtime.js']);
  });

  it('rejects import-type expressions and CommonJS/ESM helper leakage', () => {
    write(root, 'lib/index.d.ts', 'export type Leak = import("./CLI/scripts/sight-compare/types").Options;');
    write(root, 'lib/CLI/scripts/sight-compare/types.d.ts', 'export type Options = {};');
    expect(() => checkCliIsolation(root, ['lib/index.d.ts'])).toThrow('Sight CLI code is reachable');
    write(root, 'lib/index.js', 'require("./helper.cjs");');
    write(root, 'lib/helper.cjs', 'import("./helper.mjs");');
    write(root, 'lib/helper.mjs', 'export {run} from "./CLI/scripts/sight-compare/run.js";');
    write(root, 'lib/CLI/scripts/sight-compare/run.js', 'exports.run = () => {};');
    expect(() => checkCliIsolation(root, ['lib/index.js'])).toThrow('Sight CLI code is reachable');
  });
});
