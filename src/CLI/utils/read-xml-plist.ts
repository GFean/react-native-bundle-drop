import fs from 'node:fs';

/** Read native XML metadata without enabling Plist's binary/OpenStep autodetection. */
export async function readXmlPlist(file: string): Promise<Record<string, unknown>> {
  const xml = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  if (!xml.trimStart().startsWith('<')) {
    throw new Error('Info.plist must be an XML property list.');
  }

  const { parse } = await import('plist');
  const document = parse(xml);
  if (
    document === null ||
    typeof document !== 'object' ||
    Object.getPrototypeOf(document) !== Object.prototype
  ) {
    throw new Error('Info.plist must contain a dictionary.');
  }
  return document as Record<string, unknown>;
}
