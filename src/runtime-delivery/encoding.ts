const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function utf8Bytes(value: string): number[] {
  const bytes: number[] = [];
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x7f) {
      bytes.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return bytes;
}

function bytesToBase64(bytes: number[]): string {
  let result = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const triple = (first << 16) | ((second || 0) << 8) | (third || 0);
    result += BASE64_ALPHABET[(triple >> 18) & 0x3f];
    result += BASE64_ALPHABET[(triple >> 12) & 0x3f];
    result += second === undefined ? '=' : BASE64_ALPHABET[(triple >> 6) & 0x3f];
    result += third === undefined ? '=' : BASE64_ALPHABET[triple & 0x3f];
  }
  return result;
}

export function encodeBase64UrlUtf8(value: string): string {
  return bytesToBase64(utf8Bytes(value))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

export function decodeBase64UrlBytes(value: string): number[] {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new Error('Invalid base64url value');
  }
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const bytes: number[] = [];
  for (let index = 0; index < padded.length; index += 4) {
    const a = BASE64_ALPHABET.indexOf(padded[index]);
    const b = BASE64_ALPHABET.indexOf(padded[index + 1]);
    const c = padded[index + 2] === '=' ? 0 : BASE64_ALPHABET.indexOf(padded[index + 2]);
    const d = padded[index + 3] === '=' ? 0 : BASE64_ALPHABET.indexOf(padded[index + 3]);
    if (a < 0 || b < 0 || c < 0 || d < 0) throw new Error('Invalid base64url value');
    const triple = (a << 18) | (b << 12) | (c << 6) | d;
    bytes.push((triple >> 16) & 0xff);
    if (padded[index + 2] !== '=') bytes.push((triple >> 8) & 0xff);
    if (padded[index + 3] !== '=') bytes.push(triple & 0xff);
  }
  return bytes;
}

export function decodeBase64UrlUtf8(value: string): string {
  return decodeUtf8Bytes(decodeBase64UrlBytes(value));
}

export function decodeUtf8Bytes(bytes: ArrayLike<number>): string {
  let result = '';
  let segment = '';
  const flush = () => {
    result += segment;
    segment = '';
  };

  for (let index = 0; index < bytes.length;) {
    const first = bytes[index];
    let codePoint: number;
    let width: number;
    let minimum: number;

    if (first <= 0x7f) {
      codePoint = first;
      width = 1;
      minimum = 0;
    } else if (first >= 0xc2 && first <= 0xdf) {
      codePoint = first & 0x1f;
      width = 2;
      minimum = 0x80;
    } else if (first >= 0xe0 && first <= 0xef) {
      codePoint = first & 0x0f;
      width = 3;
      minimum = 0x800;
    } else if (first >= 0xf0 && first <= 0xf4) {
      codePoint = first & 0x07;
      width = 4;
      minimum = 0x10000;
    } else {
      throw new Error('Invalid UTF-8 payload');
    }

    if (index + width > bytes.length) throw new Error('Invalid UTF-8 payload');
    for (let offset = 1; offset < width; offset += 1) {
      const continuation = bytes[index + offset];
      if ((continuation & 0xc0) !== 0x80) throw new Error('Invalid UTF-8 payload');
      codePoint = (codePoint << 6) | (continuation & 0x3f);
    }
    if (
      codePoint < minimum ||
      codePoint > 0x10ffff ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      throw new Error('Invalid UTF-8 payload');
    }

    segment += String.fromCodePoint(codePoint);
    if (segment.length >= 8192) flush();
    index += width;
  }

  flush();
  return result;
}

export function utf8ByteLength(value: string): number {
  return utf8Bytes(value).length;
}
