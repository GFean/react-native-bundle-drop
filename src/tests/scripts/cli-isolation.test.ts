import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { checkCliIsolation } = require('../../../scripts/check-cli-isolation.cjs');

describe('CLI import boundary', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-boundary-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  function write(name: string, contents: string) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }

  it.each(['chalk', 'commander', 'figures', 'plist'])('rejects reachable %s imports', name => {
    write('index.js', 'require("./helper.js");');
    write('helper.js', `require(${JSON.stringify(name)});`);
    expect(() => checkCliIsolation(root, ['index.js'])).toThrow(`helper.js -> ${name}`);
  });

  it('follows explicit JavaScript extensions through source files', () => {
    write('index.ts', 'export * from "./helper.js";');
    write('helper.ts', 'import chalk from "chalk";');
    write('helper.js', '');
    expect(() => checkCliIsolation(root, ['index.ts'])).toThrow('helper.ts -> chalk');
  });

  it('follows declaration imports instead of empty runtime counterparts', () => {
    write('index.d.ts', 'export type { Metadata } from "./helper.js";');
    write('helper.d.ts', 'export type { Metadata } from "./CLI/utils/read-xml-plist.js";');
    write('helper.js', '');
    write('CLI/utils/read-xml-plist.d.ts', 'export type Metadata = {};');
    expect(() => checkCliIsolation(root, ['index.d.ts'])).toThrow('CLI/utils/read-xml-plist.d.ts');
  });

  it('permits ordinary mobile dependencies', () => {
    write('index.ts', 'import React from "react"; import { View } from "react-native";');
    expect(checkCliIsolation(root, ['index.ts'])).toEqual(['index.ts']);
  });
});
