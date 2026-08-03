import RNFS from '../native/fs';

import { BUNDLE_DROP_ROOT } from '../context';
import { atomicWriteJson, ensureDir } from './fsUtils';

const USER_PROPERTIES_PATH = `${BUNDLE_DROP_ROOT}/user-properties.json`;

export type UserPropertyValue = string | number | boolean;
export type UserProperties = Record<string, UserPropertyValue>;

type UserPropertiesPayload = {
  properties: UserProperties;
};

const MAX_USER_PROPERTY_KEY_LENGTH = 128;
const RESERVED_USER_PROPERTY_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const normalizeUserPropertyValue = (value: unknown): UserPropertyValue | null => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  return null;
};

const isValidUserPropertyKey = (key: string): boolean =>
  key.length > 0 &&
  key.length <= MAX_USER_PROPERTY_KEY_LENGTH &&
  !key.startsWith('$') &&
  !key.includes('.') &&
  !key.includes('\0') &&
  !RESERVED_USER_PROPERTY_KEYS.has(key);

async function writeUserProperties(properties: UserProperties): Promise<void> {
  await ensureDir(BUNDLE_DROP_ROOT);
  const payload: UserPropertiesPayload = { properties: { ...properties } };
  await atomicWriteJson(USER_PROPERTIES_PATH, payload);
}

/**
 * Read user properties that will be sent with OTA resolve requests.
 */
export async function getCurrentUserProperties(): Promise<UserProperties> {
  try {
    if (!(await RNFS.exists(USER_PROPERTIES_PATH))) return {};
    const raw = await RNFS.readFile(USER_PROPERTIES_PATH, 'utf8');
    const parsed = JSON.parse(raw);

    const props = parsed?.properties;
    if (!props || typeof props !== 'object' || Array.isArray(props)) return {};

    const result: UserProperties = {};
    for (const [k, v] of Object.entries(props)) {
      const key = k.trim();
      if (!isValidUserPropertyKey(key)) continue;
      const value = normalizeUserPropertyValue(v);
      if (value !== null) result[key] = value;
    }
    return result;
  } catch (e) {
    console.warn('⚠️ Failed to read user-properties.json', e);
    return {};
  }
}

/**
 * Alias for `getCurrentUserProperties()`.
 */
export async function getUserProperties(): Promise<UserProperties> {
  return getCurrentUserProperties();
}

/**
 * Set or replace one user property used for targeting future OTA resolve requests.
 *
 * Empty keys are ignored and return the current property map unchanged.
 */
export async function setUserProperty(
  key: string,
  value: UserPropertyValue,
): Promise<UserProperties> {
  const trimmedKey = key.trim();
  if (!trimmedKey) {
    return getCurrentUserProperties();
  }
  if (!isValidUserPropertyKey(trimmedKey)) {
    throw new TypeError('User property key is invalid');
  }
  const normalizedValue = normalizeUserPropertyValue(value);
  if (normalizedValue === null) {
    throw new TypeError('User property value must be a string, number, or boolean');
  }

  const existing = await getCurrentUserProperties();
  if (existing[trimmedKey] === normalizedValue) {
    return existing;
  }

  const next = { ...existing, [trimmedKey]: normalizedValue };
  await writeUserProperties(next);
  return next;
}

/**
 * Remove one user property used for targeting future OTA resolve requests.
 *
 * Empty or missing keys are ignored and return the current property map unchanged.
 */
export async function removeUserProperty(key: string): Promise<UserProperties> {
  const trimmedKey = key.trim();
  if (!trimmedKey) {
    return getCurrentUserProperties();
  }

  const existing = await getCurrentUserProperties();
  if (!(trimmedKey in existing)) {
    return existing;
  }

  const { [trimmedKey]: _, ...next } = existing;

  if (Object.keys(next).length === 0) {
    await resetUserProperties();
    return {};
  }

  await writeUserProperties(next);
  return next;
}

/**
 * Clear all locally stored user properties.
 */
export async function resetUserProperties(): Promise<void> {
  try {
    if (await RNFS.exists(USER_PROPERTIES_PATH)) {
      await RNFS.unlink(USER_PROPERTIES_PATH);
    }
  } catch (e) {
    console.warn('⚠️ Failed to reset user-properties.json', e);
  }
}
