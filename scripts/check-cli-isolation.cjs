#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const forbidden = /(?:^|\/)CLI\/scripts\/sight-(?:compare(?:\/|$)|(?:artifacts|assets|ota|session|cli)\.)/;
const cliDependencies = new Set(['chalk', 'commander', 'figures', 'plist']);

function importedModules(file) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const modules = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      modules.push(node.moduleSpecifier.text);
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      modules.push(node.argument.literal.text);
    }
    if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]) &&
        ((ts.isIdentifier(node.expression) && node.expression.text === 'require') || node.expression.kind === ts.SyntaxKind.ImportKeyword)) {
      modules.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return modules;
}

function checkCliIsolation(root, entries) {
  const visited = new Set();
  function visit(file, chain) {
    if (visited.has(file)) return;
    const relative = path.relative(root, file).split(path.sep).join('/');
    const sight = forbidden.test(relative);
    if (sight || relative.includes('CLI/utils/read-xml-plist.')) throw new Error(`${sight ? 'Sight CLI' : 'CLI'} code is reachable from an SDK/tooling entrypoint: ${[...chain, relative].join(' -> ')}`);
    visited.add(file);
    for (const name of importedModules(file)) {
      if (cliDependencies.has(name.split('/')[0])) {
        throw new Error(`CLI dependency is reachable from an SDK/tooling entrypoint: ${[...chain, relative, name].join(' -> ')}`);
      }
      if (!name.startsWith('.')) continue;
      const base = path.resolve(path.dirname(file), name);
      const stem = base.replace(/\.[cm]?js$/, '');
      const declaration = file.endsWith('.d.ts');
      const candidates = declaration
        ? [stem + '.d.ts', path.join(base, 'index.d.ts'), base]
        : /\.tsx?$/.test(file)
          ? [stem + '.ts', stem + '.tsx', base, path.join(base, 'index.ts'), path.join(base, 'index.tsx'), path.join(base, 'index.js')]
          : [base, base + '.js', base + '.cjs', base + '.mjs', path.join(base, 'index.js')];
      const resolved = candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
      if (resolved && /\.(?:[cm]?js|tsx?)$/.test(resolved)) visit(resolved, [...chain, relative]);
    }
  }
  for (const entry of entries) visit(path.join(root, entry), []);
  return [...visited].map(file => path.relative(root, file).split(path.sep).join('/')).sort();
}

module.exports = { checkCliIsolation };

if (require.main === module) {
  const modules = checkCliIsolation(process.cwd(), [
    'lib/index.js', 'lib/bootstrap.js', 'lib/index.d.ts', 'lib/metro.js', 'lib/metro.d.ts', 'app.plugin.js',
    'src/index.tsx', 'src/bootstrap.ts', 'src/metro.ts',
  ]);
  console.log(`CLI isolation check passed: ${modules.length} SDK/tooling modules inspected; no Sight or CLI dependency imports.`);
}
