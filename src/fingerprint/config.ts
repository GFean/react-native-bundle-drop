import type { FingerprintOptions } from './types';

type RuntimeSelection =
  | { source: 'manual'; runtimeVersion: string }
  | { source: 'expo' }
  | { source: 'fingerprint'; boundary: string | null; options: FingerprintOptions };

/** Validate selectors once, independently of Expo/project detection. */
export function selectRuntimeVersion(value: unknown, platform: 'ios' | 'android'): RuntimeSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`bundle.drop.config.js must define runtimeVersion.${platform}.`);
  }
  const config = value as Record<string, unknown>;
  if (config.source !== undefined) {
    if (config.source !== 'expo') throw new Error('Unsupported runtimeVersion.source.');
    if (['compatibilitySource', 'fingerprint', 'ios', 'android'].some(key => config[key] !== undefined)) {
      throw new Error('runtimeVersion.source: expo cannot be combined with compatibilitySource, fingerprint options, or platform literals.');
    }
    return { source: 'expo' };
  }
  if (config.compatibilitySource !== undefined && config.compatibilitySource !== 'manual' && config.compatibilitySource !== 'fingerprint') {
    throw new Error('Unsupported runtimeVersion.compatibilitySource.');
  }
  if (config.compatibilitySource === 'fingerprint') {
    for (const name of ['ios', 'android']) {
      const boundary = config[name];
      if (boundary !== undefined && (typeof boundary !== 'string' || !boundary.trim())) {
        throw new Error(`Fingerprint runtimeVersion.${name} must be a non-empty literal or omitted.`);
      }
    }
    const options = config.fingerprint ?? {};
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new Error('runtimeVersion.fingerprint must be an object.');
    }
    const typed = options as FingerprintOptions;
    if (Object.keys(options).some(key => !['schemeVersion', 'nativeProjectMode', 'extraSources'].includes(key))) {
      throw new Error('Unsupported runtimeVersion.fingerprint option.');
    }
    if (typed.schemeVersion !== undefined && typed.schemeVersion !== 1) {
      throw new Error('Unsupported fingerprint scheme. Only scheme 1 is available.');
    }
    if (typed.nativeProjectMode !== undefined) {
      if (!typed.nativeProjectMode || typeof typed.nativeProjectMode !== 'object' || Array.isArray(typed.nativeProjectMode)) {
        throw new Error('fingerprint.nativeProjectMode must be a platform map.');
      }
      for (const mode of Object.values(typed.nativeProjectMode)) {
        if (mode !== 'native' && mode !== 'cng') throw new Error('Unsupported fingerprint nativeProjectMode.');
      }
    }
    if (typed.extraSources !== undefined && !Array.isArray(typed.extraSources)) {
      throw new Error('fingerprint.extraSources must be an array.');
    }
    return { source: 'fingerprint', boundary: (config[platform] as string | undefined)?.trim() ?? null, options: typed };
  }
  if (config.fingerprint !== undefined) throw new Error('Fingerprint options require compatibilitySource: fingerprint.');
  const literal = config[platform];
  if (typeof literal !== 'string' || !literal.trim()) {
    throw new Error(`bundle.drop.config.js must define a non-empty runtimeVersion.${platform} literal. Use runtimeVersion: { source: 'expo' } only when explicitly opting into Expo runtime policies.`);
  }
  return { source: 'manual', runtimeVersion: literal.trim() };
}
