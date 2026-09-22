import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readXmlPlist } from '../../../CLI/utils/read-xml-plist';

describe('XML Info.plist metadata reader', () => {
  let directory: string;
  let file: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-drop-xml-plist-'));
    file = path.join(directory, 'Info.plist');
  });

  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  it('reads a real XML dictionary while preserving Xcode placeholders and Unicode', async () => {
    fs.writeFileSync(file, '\uFEFF<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!-- Native app metadata --><plist version="1.0"><dict>' +
      '<key>CFBundleShortVersionString</key><string>$(MARKETING_VERSION)</string>' +
      '<key>CFBundleDisplayName</key><string>ქართული &amp; English</string>' +
      '</dict></plist>');
    expect(await readXmlPlist(file)).toEqual({
      CFBundleShortVersionString: '$(MARKETING_VERSION)',
      CFBundleDisplayName: 'ქართული & English',
    });
  });

  it.each([
    ['binary', Buffer.from('bplist00\0\0\0')],
    ['OpenStep', '{ CFBundleShortVersionString = "1.2.3"; }'],
    ['empty', ''],
  ])('rejects %s before format autodetection', async (_name, contents) => {
    fs.writeFileSync(file, contents);
    await expect(readXmlPlist(file)).rejects.toThrow('must be an XML property list');
  });

  it.each(['<array/>', '<string>1.2.3</string>', '<null/>', '<data>YQ==</data>', '<date>2026-01-01T00:00:00Z</date>'])
    ('rejects a non-dictionary XML root: %s', async root => {
      fs.writeFileSync(file, `<plist version="1.0">${root}</plist>`);
      await expect(readXmlPlist(file)).rejects.toThrow('must contain a dictionary');
    });

  it('rejects malformed XML', async () => {
    const diagnostic = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      fs.writeFileSync(file, '<plist><dict><key>version</key><string>1.2.3</dict></plist>');
      await expect(readXmlPlist(file)).rejects.toThrow();
    } finally {
      diagnostic.mockRestore();
    }
  });

  it('does not accept prototype-derived metadata', async () => {
    fs.writeFileSync(file, '<plist><dict><key>__proto__</key><dict>' +
      '<key>CFBundleShortVersionString</key><string>9.9.9</string></dict></dict></plist>');
    await expect(readXmlPlist(file)).rejects.toThrow();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'CFBundleShortVersionString')).toBe(false);
  });

  it('reads nested XML dictionaries without repeated exponential parsing', async () => {
    const depth = 32;
    fs.writeFileSync(file, '<plist>' + '<dict><key>nested</key>'.repeat(depth) +
      '<string>value</string>' + '</dict>'.repeat(depth) + '</plist>');
    let value: unknown = await readXmlPlist(file);
    for (let i = 0; i < depth; i += 1) value = (value as Record<string, unknown>).nested;
    expect(value).toBe('value');
  });

  it('preserves filesystem errors', async () => {
    await expect(readXmlPlist(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
