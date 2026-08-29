#!/usr/bin/env node

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

export async function runDownloadBundle(options?: {
  argv?: string[];
  cwd?: string;
  packageRoot?: string;
}) {
  const packageRoot = options?.packageRoot || path.resolve(__dirname, '..', '..');
  const outputDir = path.join(packageRoot, 'dist');
  const argv = options?.argv || process.argv;
  const platform = argv[2];

  if (!platform || !['ios', 'android'].includes(platform)) {
    console.error('❌ Please provide platform: ios or android');
    process.exit(1);
  }

  const projectRoot = options?.cwd || process.cwd();
  const configPath = path.resolve(projectRoot, 'bundle.drop.config.js');

  if (!fs.existsSync(configPath)) {
    console.error('❌ bundle.drop.config.js not found in project root');
    process.exit(1);
  }

  // eslint-disable-next-line
  const config = require(configPath);
  const { serverUrl, project } = config;

  if (!serverUrl) {
    console.error('❌ Missing "serverUrl" in bundle.drop.config.js');
    process.exit(1);
  }

  if (!project?.slug) {
    console.error('❌ Missing "project.slug" in bundle.drop.config.js');
    process.exit(1);
  }

  const runtimeVersion =
    config?.runtimeVersion?.[platform as 'ios' | 'android'] || config?.runtimeVersion?.[platform];
  const channelName = argv[3] || config?.defaultChannel || 'develop';
  const resolveEndpoint = `${serverUrl}/projects/${encodeURIComponent(project.slug)}/ota/resolve`;
  const outputPath = path.join(outputDir, `bundle-${platform}.zip`);

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const authHeaders = {
    ...(project?.apiKey ? { 'x-api-key': project.apiKey } : {}),
  };

  try {
    console.log(`⬇️ Resolving OTA target from: ${resolveEndpoint}`);
    const resolveResponse = await axios.post(
      resolveEndpoint,
      {
        channelName,
        platform,
        runtimeVersion: runtimeVersion ?? null,
        environment: null,
        currentHash: null,
        rejectedHashes: [],
        installId: 'cli-download',
        currentUserProperties: {},
        transport: {
          manifestVersion: 1,
          patchAlgorithms: [],
          supportsContentAddressedAssets: true,
        },
      },
      {
        headers: {
          Accept: 'application/json',
          ...authHeaders,
        },
        timeout: 15000,
      },
    );

    const decision = resolveResponse.data;
    const bundleDownloadUrl =
      decision?.action === 'INSTALL' && decision?.mode === 'patch'
        ? decision?.fallback?.downloadUrl
        : decision?.action === 'INSTALL'
          ? decision?.target?.downloadUrl
          : null;
    if (!bundleDownloadUrl) {
      console.error('❌ Resolve did not return an INSTALL decision with a full bundle downloadUrl');
      process.exit(1);
    }

    console.log(`⬇️ Downloading latest ${platform} full bundle ZIP from signed URL...`);
    const bundleResponse = await axios.get(bundleDownloadUrl, { responseType: 'arraybuffer' });
    await fs.promises.writeFile(outputPath, Buffer.from(bundleResponse.data));
    console.log(`✅ Bundle ZIP downloaded and saved to: ${outputPath}`);

    return outputPath;
  } catch (err: any) {
    console.error('❌ Download failed:', err.response?.data || err.message || err);
    process.exit(1);
  }
}

if (require.main === module) {
  runDownloadBundle();
}
