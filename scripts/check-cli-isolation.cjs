#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const forbidden = /(?:^|\/)CLI\/scripts\/sight-(?:compare(?:\/|$)|(?:artifacts|assets|ota|session|cli)\.)/;

function relativeModules(file) {
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
  return modules.filter(name => name.startsWith('.'));
}

function checkCliIsolation(root, entries) {
  const visited = new Set();
  function visit(file, chain) {
    if (visited.has(file)) return;
    const relative = path.relative(root, file).split(path.sep).join('/');
    if (forbidden.test(relative)) throw new Error(`Sight CLI code is reachable from an SDK/tooling entrypoint: ${[...chain, relative].join(' -> ')}`);
    visited.add(file);
    for (const name of relativeModules(file)) {
      const base = path.resolve(path.dirname(file), name);
      const declaration = file.endsWith('.d.ts');
      const candidates = declaration
        ? [base + '.d.ts', path.join(base, 'index.d.ts'), base]
        : [base + '.js', base + '.cjs', base + '.mjs', base + '.ts', base + '.tsx', path.join(base, 'index.js'), path.join(base, 'index.ts'), path.join(base, 'index.tsx'), base];
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
  console.log(`CLI isolation check passed: ${modules.length} SDK/tooling modules inspected; no Sight comparison imports.`);
}
