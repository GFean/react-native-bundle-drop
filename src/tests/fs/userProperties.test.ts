import {
  getCurrentUserProperties,
  getUserProperties,
  removeUserProperty,
  resetUserProperties,
  setUserProperty,
} from '../../fs/userProperties';
import { getMockFile, mockUnlink, resetNativeFsMocks, setMockFile } from '../mocks/native/fs';

jest.mock('../../context', () => require('../mocks/context'));
jest.mock('../../native/fs', () => require('../mocks/native/fs'));

const USER_PROPERTIES_PATH = '/mock/doc/bundle-drop/user-properties.json';

describe('fs/userProperties', () => {
  beforeEach(() => {
    resetNativeFsMocks();
  });

  it('reads and normalizes saved user properties', async () => {
    setMockFile(
      USER_PROPERTIES_PATH,
      JSON.stringify({
        properties: {
          ' tier ': 'beta',
          stable: 'general',
          age: 33,
          beta: true,
          '': 'ignored',
          '$bad': 'ignored',
          'plan.tier': 'ignored',
          constructor: 'ignored',
          invalid: {},
          nan: Number.NaN,
        },
      })
    );

    await expect(getCurrentUserProperties()).resolves.toEqual({
      tier: 'beta',
      stable: 'general',
      age: 33,
      beta: true,
    });
    await expect(getUserProperties()).resolves.toEqual({
      tier: 'beta',
      stable: 'general',
      age: 33,
      beta: true,
    });
  });

  it('writes a trimmed property key and keeps existing values', async () => {
    setMockFile(
      USER_PROPERTIES_PATH,
      JSON.stringify({
        properties: {
          tier: 'beta',
        },
      })
    );

    await expect(setUserProperty(' region ', 'eu')).resolves.toEqual({
      tier: 'beta',
      region: 'eu',
    });
    await expect(setUserProperty('age', 33)).resolves.toEqual({
      tier: 'beta',
      region: 'eu',
      age: 33,
    });
    await expect(setUserProperty('beta', true)).resolves.toEqual({
      tier: 'beta',
      region: 'eu',
      age: 33,
      beta: true,
    });

    expect(JSON.parse(getMockFile(USER_PROPERTIES_PATH) || '{}')).toEqual({
      properties: {
        tier: 'beta',
        region: 'eu',
        age: 33,
        beta: true,
      },
    });
  });

  it('rejects invalid runtime values before writing', async () => {
    await expect(setUserProperty('bad', Number.NaN)).rejects.toThrow(
      'User property value must be a string, number, or boolean',
    );
    await expect(setUserProperty('bad', {} as never)).rejects.toThrow(
      'User property value must be a string, number, or boolean',
    );
    expect(getMockFile(USER_PROPERTIES_PATH)).toBeUndefined();
  });

  it('rejects invalid user property keys before writing', async () => {
    await expect(setUserProperty('$bad', 'x')).rejects.toThrow(
      'User property key is invalid',
    );
    await expect(setUserProperty('plan.tier', 'x')).rejects.toThrow(
      'User property key is invalid',
    );
    await expect(setUserProperty('__proto__', 'x')).rejects.toThrow(
      'User property key is invalid',
    );
    await expect(setUserProperty('a'.repeat(129), 'x')).rejects.toThrow(
      'User property key is invalid',
    );
    expect(getMockFile(USER_PROPERTIES_PATH)).toBeUndefined();
  });

  it('returns empty properties and warns when the saved payload cannot be parsed', async () => {
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    setMockFile(USER_PROPERTIES_PATH, '{invalid json');

    try {
      await expect(getCurrentUserProperties()).resolves.toEqual({});
      expect(consoleSpy).toHaveBeenCalledWith(
        '⚠️ Failed to read user-properties.json',
        expect.any(Error),
      );
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('returns an empty object when the saved properties payload is an array', async () => {
    setMockFile(
      USER_PROPERTIES_PATH,
      JSON.stringify({
        properties: ['beta', 'qa'],
      }),
    );

    await expect(getCurrentUserProperties()).resolves.toEqual({});
  });

  it('does not persist empty keys and keeps duplicate values unchanged', async () => {
    setMockFile(
      USER_PROPERTIES_PATH,
      JSON.stringify({
        properties: {
          tier: 'beta',
        },
      })
    );

    await expect(setUserProperty('   ', 'ignored')).resolves.toEqual({ tier: 'beta' });
    await expect(setUserProperty('tier', 'beta')).resolves.toEqual({ tier: 'beta' });

    expect(JSON.parse(getMockFile(USER_PROPERTIES_PATH) || '{}')).toEqual({
      properties: {
        tier: 'beta',
      },
    });
  });

  it('removes a single property and deletes the file when the last one is removed', async () => {
    setMockFile(
      USER_PROPERTIES_PATH,
      JSON.stringify({
        properties: {
          tier: 'beta',
          region: 'eu',
        },
      })
    );

    await expect(removeUserProperty('region')).resolves.toEqual({ tier: 'beta' });
    expect(JSON.parse(getMockFile(USER_PROPERTIES_PATH) || '{}')).toEqual({
      properties: {
        tier: 'beta',
      },
    });

    await expect(removeUserProperty('tier')).resolves.toEqual({});
    expect(getMockFile(USER_PROPERTIES_PATH)).toBeUndefined();
  });

  it('keeps current properties when removing an empty or unknown key', async () => {
    setMockFile(
      USER_PROPERTIES_PATH,
      JSON.stringify({
        properties: {
          tier: 'beta',
        },
      }),
    );

    await expect(removeUserProperty('   ')).resolves.toEqual({ tier: 'beta' });
    await expect(removeUserProperty('region')).resolves.toEqual({ tier: 'beta' });
  });

  it('resets the properties file without failing when it does not exist', async () => {
    setMockFile(
      USER_PROPERTIES_PATH,
      JSON.stringify({
        properties: {
          tier: 'beta',
        },
      })
    );

    await resetUserProperties();
    await resetUserProperties();

    expect(getMockFile(USER_PROPERTIES_PATH)).toBeUndefined();
  });

  it('warns when resetting the properties file fails', async () => {
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    setMockFile(
      USER_PROPERTIES_PATH,
      JSON.stringify({
        properties: {
          tier: 'beta',
        },
      }),
    );
    mockUnlink.mockRejectedValueOnce(new Error('permission denied'));

    try {
      await resetUserProperties();
      expect(consoleSpy).toHaveBeenCalledWith(
        '⚠️ Failed to reset user-properties.json',
        expect.any(Error),
      );
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
