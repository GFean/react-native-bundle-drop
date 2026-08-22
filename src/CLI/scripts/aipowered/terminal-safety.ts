import type { AiSetupPlanResponse } from './types';
import { findKnownBundleDropCredential } from './credential-safety';

const CONFIDENCE_VALUES = new Set(['high', 'medium', 'low']);
const DECISION_VALUES = new Set([
  'safe_auto_patch',
  'review_only_patch',
  'manual_fallback',
  'skip',
]);
const ACTION_VALUES = new Set([
  'register_expo_plugin',
  'configure_bundle_drop',
  'preserve_expo_metro',
  'migrate_expo_updates',
  'configure_bare_native',
  'migrate_codepush',
  'require_native_rebuild',
  'run_doctor',
]);

const BIDI_CONTROL = /[\u202A-\u202E\u2066-\u2069]/u;
const JAVASCRIPT_LINE_SEPARATOR = /[\u2028\u2029]/u;

const isUnsafeControlAt = (value: string, index: number) => {
  const code = value.charCodeAt(index);
  if (code === 0x09 || code === 0x0a) return false;
  if (code === 0x0d && value.charCodeAt(index + 1) === 0x0a) return false;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
};

export const hasUnsafeTerminalControl = (value: string) => {
  if (BIDI_CONTROL.test(value) || JAVASCRIPT_LINE_SEPARATOR.test(value)) return true;
  for (let index = 0; index < value.length; index += 1) {
    if (isUnsafeControlAt(value, index)) return true;
  }
  return false;
};

export const escapeTerminalControls = (value: string) => {
  let escaped = '';
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (character === '\n' || character === '\t') {
      escaped += character;
    } else if (character === '\r') {
      escaped += '\\r';
    } else if (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029 ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      escaped += code <= 0xff
        ? `\\x${code.toString(16).padStart(2, '0')}`
        : `\\u${code.toString(16).padStart(4, '0')}`;
    } else {
      escaped += character;
    }
  }
  return escaped;
};

const requireSafeProviderText = (label: string, value: unknown) => {
  if (typeof value !== 'string') {
    throw new Error(`AI setup response contains a non-text ${label}. No files changed.`);
  }
  if (hasUnsafeTerminalControl(value)) {
    throw new Error(`AI setup response contains unsafe terminal controls in ${label}. No files changed.`);
  }
  if (findKnownBundleDropCredential(value)) {
    throw new Error(`AI setup response contains a private Bundle Drop credential in ${label}. No files changed.`);
  }
};

export function assertSafeProviderPlan(plan: unknown): asserts plan is AiSetupPlanResponse {
  if (!plan || typeof plan !== 'object') {
    throw new Error('AI setup response is not an object. No files changed.');
  }
  const candidate = plan as Partial<AiSetupPlanResponse>;
  if (!CONFIDENCE_VALUES.has(String(candidate.confidence))) {
    throw new Error('AI setup response contains an invalid confidence. No files changed.');
  }
  requireSafeProviderText('summary', candidate.summary);
  if (!Array.isArray(candidate.warnings) || !Array.isArray(candidate.actions) ||
      !Array.isArray(candidate.changes)) {
    throw new Error('AI setup response is missing typed action, warning, or change arrays. No files changed.');
  }
  candidate.warnings.forEach((warning, index) =>
    requireSafeProviderText(`warning ${index + 1}`, warning)
  );
  candidate.actions.forEach((action, index) => {
    if (!action || typeof action !== 'object') {
      throw new Error(`AI setup response contains an invalid action ${index + 1}. No files changed.`);
    }
    requireSafeProviderText(`action ${index + 1} type`, action.type);
    requireSafeProviderText(`action ${index + 1} reason`, action.reason);
    if (!ACTION_VALUES.has(action.type)) {
      throw new Error(`AI setup response contains an unsupported action ${index + 1}. No files changed.`);
    }
    if (typeof action.requiresConfirmation !== 'boolean') {
      throw new Error(
        `AI setup response contains a non-boolean confirmation flag for action ${index + 1}. ` +
          'No files changed.',
      );
    }
  });
  candidate.changes.forEach((change, index) => {
    if (!change || typeof change !== 'object') {
      throw new Error(`AI setup response contains an invalid change ${index + 1}. No files changed.`);
    }
    requireSafeProviderText(`change ${index + 1} file`, change.file);
    requireSafeProviderText(`change ${index + 1} original hash`, change.originalSha256);
    requireSafeProviderText(`change ${index + 1} reason`, change.reason);
    requireSafeProviderText(`change ${index + 1} content`, change.updated);
    if (!CONFIDENCE_VALUES.has(String(change.confidence))) {
      throw new Error(`AI setup response contains an invalid change confidence ${index + 1}. No files changed.`);
    }
    if (!DECISION_VALUES.has(String(change.decisionType))) {
      throw new Error(`AI setup response contains an invalid change decision ${index + 1}. No files changed.`);
    }
  });
}
