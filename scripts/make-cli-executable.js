/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");

function chmodIfExists(relPath) {
  const abs = path.resolve(__dirname, "..", relPath);

  if (!fs.existsSync(abs)) {
    console.warn(`[bundle-drop] skip chmod, not found: ${relPath}`);
    return;
  }

  try {
    // 0o755: rwxr-xr-x
    fs.chmodSync(abs, 0o755);
    console.log(`[bundle-drop] chmod +x ${relPath}`);
  } catch (e) {
    // Windows or restricted FS: not fatal
    console.warn(`[bundle-drop] chmod failed for ${relPath}: ${e?.message || e}`);
  }
}

chmodIfExists("lib/CLI/cli.js");
