#!/usr/bin/env node
// The maintained upstream adaptation lives outside src/. Keep its notices and
// source provenance separate, and compile it reproducibly for the npm package.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '..', 'third_party', 'expo-fingerprint');
const sourceRoot = path.join(root, 'src');
const outputRoot = path.join(root, 'build');
fs.rmSync(outputRoot, { recursive: true, force: true });

function compile(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('__')) continue;
    const sourcePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      compile(sourcePath);
    } else if (entry.name.endsWith('.ts')) {
      const outputPath = path.join(outputRoot, path.relative(sourceRoot, sourcePath).replace(/\.ts$/, '.js'));
      const { outputText } = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
      });
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, outputText);
    }
  }
}
compile(sourceRoot);
