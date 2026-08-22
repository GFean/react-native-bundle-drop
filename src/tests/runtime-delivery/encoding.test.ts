import {
  decodeBase64UrlBytes,
  decodeBase64UrlUtf8,
  decodeUtf8Bytes,
  encodeBase64UrlUtf8,
  utf8ByteLength,
} from '../../runtime-delivery/encoding';

describe('runtime-delivery/encoding', () => {
  it('round-trips ASCII and every UTF-8 width without relying on Buffer at runtime', () => {
    const value = 'Aβह😀';
    const expected = Buffer.from(value, 'utf8').toString('base64url');
    expect(encodeBase64UrlUtf8(value)).toBe(expected);
    expect(decodeBase64UrlUtf8(expected)).toBe(value);
    expect(decodeBase64UrlBytes(expected)).toEqual([...Buffer.from(value, 'utf8')]);
    expect(utf8ByteLength(value)).toBe(Buffer.byteLength(value));
    expect(encodeBase64UrlUtf8('a')).toBe('YQ');
    expect(encodeBase64UrlUtf8('ab')).toBe('YWI');
    expect(encodeBase64UrlUtf8('abc')).toBe('YWJj');
  });

  it('decodes streamed UTF-8 bytes and rejects malformed or truncated sequences', () => {
    expect(decodeUtf8Bytes(new Uint8Array(Buffer.from('Bundle β 🚀', 'utf8')))).toBe(
      'Bundle β 🚀',
    );
    expect(() => decodeUtf8Bytes(new Uint8Array([0xc0, 0x80]))).toThrow('Invalid UTF-8');
    expect(() => decodeUtf8Bytes(new Uint8Array([0xc2, 0x41]))).toThrow('Invalid UTF-8');
    expect(() => decodeUtf8Bytes(new Uint8Array([0xf0, 0x9f, 0x9a]))).toThrow('Invalid UTF-8');
    expect(() => decodeUtf8Bytes(new Uint8Array([0xed, 0xa0, 0x80]))).toThrow('Invalid UTF-8');
  });

  it('rejects non-base64url input, malformed quanta, and invalid UTF-8', () => {
    expect(() => decodeBase64UrlBytes('$')).toThrow('Invalid base64url');
    expect(() => decodeBase64UrlBytes('A')).toThrow('Invalid base64url');
    expect(() => decodeBase64UrlUtf8('_w')).toThrow('Invalid UTF-8');
  });
});
