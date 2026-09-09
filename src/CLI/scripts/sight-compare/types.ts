import type { MobilePlatform, ProjectType } from '../../../expo';
import type { SightArtifacts } from '../sight-artifacts';

export type ComparisonEntryPoint = { kind: 'relative' | 'module'; value: string };
export type ComparisonSourceContext = {
  repositoryRoot: string;
  projectRelativePath: string;
  sourcesBase: string;
  pathConvention?: 'filesystem' | 'expo-server-root';
};
export type ComparisonSide = {
  label: string;
  commit: string;
  branch: string | null;
  dirty: boolean;
  projectType: ProjectType;
  versions: { reactNative: string; expo?: string; metro?: string };
  packageManager: { name: 'npm' | 'yarn' | 'pnpm'; version: string };
  builtAt: string;
  inputFingerprint: string;
  configFingerprint: string;
  sourceContext: ComparisonSourceContext;
};
export type ComparisonArtifactField = 'baselineBundle' | 'baselineSourceMap' | 'currentBundle' | 'currentSourceMap';
export type ComparisonArtifact = { path: string; bytes: number; sha256: string };
export type ComparisonAssetEntry = { path: string; bytes: number; sha256: string };
export type SightOtaMeasurement =
  | { status: 'available'; engine: 'hermes' | 'javascript'; bundleBytes: number; zipBytes: number }
  | { status: 'unavailable'; reason: string };
export type ComparisonAssetManifest = {
  version: 1;
  metric: 'emitted-asset-bytes';
  baseline: ComparisonAssetEntry[];
  current: ComparisonAssetEntry[];
  ota?: { baseline: SightOtaMeasurement; current: SightOtaMeasurement };
};
export type ComparisonMetadata = {
  version: 2;
  mode: 'compare';
  metric: 'javascript-utf8-bytes';
  settings: {
    platform: MobilePlatform;
    dev: false;
    minify: true;
    nodeVersion: string;
    entryPoint: ComparisonEntryPoint;
  };
  baseline: ComparisonSide;
  current: ComparisonSide;
  artifacts: Record<ComparisonArtifactField, ComparisonArtifact>;
  assetManifest?: ComparisonArtifact;
  includedPaths: string[];
  warnings: string[];
};
export type ComparisonArtifacts = {
  outputDirectory: string;
  metadataPath: string;
  assetManifestPath?: string;
  baseline: SightArtifacts;
  current: SightArtifacts;
};
