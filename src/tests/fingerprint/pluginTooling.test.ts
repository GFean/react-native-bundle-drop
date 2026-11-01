import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

it('ignores a project copy of the loader resolution utility while retaining real config plugin sources', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bd-plugin-capture-')));
  const write = (name: string, contents: string) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  };
  try {
    write('package.json', '{"name":"plugin-fixture"}');
    write('node_modules/expo/package.json', '{"name":"expo","version":"57.0.0"}');
    write('node_modules/@expo/env/index.js', 'exports.load=()=>{};');
    write('node_modules/expo/config.js', 'exports.getConfig=(root, options)=>{ if(!options.skipPlugins) require(root+"/plugin.js"); return {exp:{name:"Fixture",slug:"fixture"}}; };');
    write('node_modules/resolve-from/index.js', 'module.exports="project resolution helper";');
    write('plugin.js', 'require("resolve-from"); require("./native-plugin.js");');
    write('native-plugin.js', 'module.exports={nativePermission:"CAMERA"};');
    const loader = path.resolve(__dirname, '../../../third_party/expo-fingerprint/build/ExpoConfigLoader.js');
    const run = (skip: boolean) => {
      const result = spawnSync(process.execPath, [loader, root, '--mode', 'production', ...(skip ? ['--skipPlugins'] : [])], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      return JSON.parse(result.stdout).loadedModules as Array<{ path?: string }>;
    };
    const included = run(false).map(source => source.path);
    expect(included).toContain('native-plugin.js');
    expect(included).toContain('plugin.js');
    expect(included).not.toContain('node_modules/resolve-from/index.js');
    expect(run(true).map(source => source.path)).not.toContain('native-plugin.js');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
