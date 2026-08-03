#import "BundleDropZipExtractor.h"
#include <zlib.h>

static uint16_t zipRead16(const uint8_t *buf) {
  return (uint16_t)buf[0] | ((uint16_t)buf[1] << 8);
}

static uint32_t zipRead32(const uint8_t *buf) {
  return (uint32_t)buf[0] | ((uint32_t)buf[1] << 8) |
         ((uint32_t)buf[2] << 16) | ((uint32_t)buf[3] << 24);
}

@implementation BundleDropZipExtractor

static const NSUInteger kMaxZipFileSize = 256 * 1024 * 1024; // 256 MB
static const NSUInteger kMaxEntrySize = 128 * 1024 * 1024;  // 128 MB per entry
static const NSUInteger kMaxTotalUncompressed = 512 * 1024 * 1024; // 512 MB total
static const uint32_t kUnixSymlinkFileType = 0120000;
static const uint32_t kUnixFileTypeMask = 0170000;

+ (BOOL)isPath:(NSString *)path safelyInsideDirectory:(NSString *)dir {
  NSString *resolvedDir = [dir stringByResolvingSymlinksInPath];
  NSString *resolvedPath = [path stringByResolvingSymlinksInPath];
  NSString *prefix = [resolvedDir stringByAppendingString:@"/"];
  return [resolvedPath hasPrefix:prefix];
}

+ (BOOL)isWindowsAbsolutePath:(NSString *)path {
  if (path.length < 3) return NO;
  unichar first = [path characterAtIndex:0];
  unichar second = [path characterAtIndex:1];
  unichar third = [path characterAtIndex:2];
  BOOL hasDriveLetter = (first >= 'A' && first <= 'Z') || (first >= 'a' && first <= 'z');
  return hasDriveLetter && second == ':' && (third == '/' || third == '\\');
}

+ (BOOL)isSymlinkExternalAttributes:(uint32_t)externalAttributes {
  uint32_t unixMode = (externalAttributes >> 16) & 0xffff;
  return (unixMode & kUnixFileTypeMask) == kUnixSymlinkFileType;
}

+ (NSString *)normalizedZipEntryName:(NSString *)name error:(NSError **)error {
  if (name.length == 0 ||
      [name containsString:@"\0"] ||
      [name containsString:@"\\"] ||
      [name hasPrefix:@"/"] ||
      [self isWindowsAbsolutePath:name]) {
    if (error)
      *error = [NSError errorWithDomain:@"BundleDrop" code:9
                               userInfo:@{NSLocalizedDescriptionKey:
                    [NSString stringWithFormat:@"Unsafe ZIP entry path: %@", name]}];
    return nil;
  }

  NSString *normalized = [name hasSuffix:@"/"]
    ? [name substringToIndex:name.length - 1]
    : name;
  if (normalized.length == 0) {
    if (error)
      *error = [NSError errorWithDomain:@"BundleDrop" code:9
                               userInfo:@{NSLocalizedDescriptionKey:
                    [NSString stringWithFormat:@"Unsafe ZIP entry path: %@", name]}];
    return nil;
  }

  NSArray<NSString *> *parts = [normalized componentsSeparatedByString:@"/"];
  for (NSString *part in parts) {
    if (part.length == 0 || [part isEqualToString:@"."] || [part isEqualToString:@".."]) {
      if (error)
        *error = [NSError errorWithDomain:@"BundleDrop" code:9
                                 userInfo:@{NSLocalizedDescriptionKey:
                      [NSString stringWithFormat:@"Unsafe ZIP entry path: %@", name]}];
      return nil;
    }
  }
  return normalized;
}

+ (NSArray<NSString *> *)extractZipAtPath:(NSString *)zipPath
                              toDirectory:(NSString *)destPath
                                    error:(NSError **)error {
  return [self extractZipAtPath:zipPath
                    toDirectory:destPath
                 maxZipFileSize:kMaxZipFileSize
                   maxEntrySize:kMaxEntrySize
           maxTotalUncompressed:kMaxTotalUncompressed
                          error:error];
}

+ (NSArray<NSString *> *)extractZipAtPath:(NSString *)zipPath
                              toDirectory:(NSString *)destPath
                           maxZipFileSize:(NSUInteger)maxZipFileSize
                             maxEntrySize:(NSUInteger)maxEntrySize
                     maxTotalUncompressed:(NSUInteger)maxTotalUncompressed
                                    error:(NSError **)error {
  NSDictionary *attrs = [[NSFileManager defaultManager] attributesOfItemAtPath:zipPath error:error];
  if (!attrs) return nil;
  NSUInteger fileSize = [attrs[NSFileSize] unsignedIntegerValue];
  if (fileSize > maxZipFileSize) {
    if (error)
      *error = [NSError errorWithDomain:@"BundleDrop" code:5
                               userInfo:@{NSLocalizedDescriptionKey:
                  [NSString stringWithFormat:@"ZIP too large: %lu bytes (max %lu)",
                   (unsigned long)fileSize, (unsigned long)maxZipFileSize]}];
    return nil;
  }

  NSData *data = [NSData dataWithContentsOfFile:zipPath options:0 error:error];
  if (!data) return nil;

  const uint8_t *bytes = data.bytes;
  NSUInteger length = data.length;

  NSInteger eocdOffset = -1;
  for (NSInteger i = (NSInteger)length - 22;
       i >= 0 && i >= (NSInteger)length - 65557; i--) {
    if (zipRead32(bytes + i) == 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset < 0) {
    if (error)
      *error = [NSError errorWithDomain:@"BundleDrop" code:1
                               userInfo:@{NSLocalizedDescriptionKey: @"Invalid ZIP: end-of-central-directory not found"}];
    return nil;
  }

  uint16_t entryCount = zipRead16(bytes + eocdOffset + 10);
  uint32_t cdOffset   = zipRead32(bytes + eocdOffset + 16);

  NSFileManager *fm = [NSFileManager defaultManager];
  if (![fm fileExistsAtPath:destPath]) {
    [fm createDirectoryAtPath:destPath withIntermediateDirectories:YES attributes:nil error:nil];
  }

  NSMutableArray<NSString *> *filenames = [NSMutableArray new];
  NSMutableSet<NSString *> *seenEntries = [NSMutableSet new];
  NSUInteger offset = cdOffset;
  NSUInteger totalUncompressed = 0;

  for (uint16_t idx = 0; idx < entryCount; idx++) {
    if (offset + 46 > length) break;
    if (zipRead32(bytes + offset) != 0x02014b50) break;

    uint16_t method          = zipRead16(bytes + offset + 10);
    uint32_t compressedSize  = zipRead32(bytes + offset + 20);
    uint32_t uncompressedSize = zipRead32(bytes + offset + 24);
    uint16_t nameLen         = zipRead16(bytes + offset + 28);
    uint16_t extraLen        = zipRead16(bytes + offset + 30);
    uint16_t commentLen      = zipRead16(bytes + offset + 32);
    uint32_t externalAttrs   = zipRead32(bytes + offset + 38);
    uint32_t localHdrOffset  = zipRead32(bytes + offset + 42);

    if (offset + 46 + nameLen > length) break;

    NSString *name = [[NSString alloc] initWithBytes:bytes + offset + 46
                                              length:nameLen
                                            encoding:NSUTF8StringEncoding];
    offset += 46 + nameLen + extraLen + commentLen;

    if (!name) continue;
    NSString *normalizedName = [self normalizedZipEntryName:name error:error];
    if (!normalizedName) return nil;
    if ([self isSymlinkExternalAttributes:externalAttrs]) {
      if (error)
        *error = [NSError errorWithDomain:@"BundleDrop" code:10
                                 userInfo:@{NSLocalizedDescriptionKey:
                    [NSString stringWithFormat:@"Symlink ZIP entries are not allowed: %@", normalizedName]}];
      return nil;
    }
    if ([seenEntries containsObject:normalizedName]) {
      if (error)
        *error = [NSError errorWithDomain:@"BundleDrop" code:11
                                 userInfo:@{NSLocalizedDescriptionKey:
                    [NSString stringWithFormat:@"Duplicate ZIP entry: %@", normalizedName]}];
      return nil;
    }
    [seenEntries addObject:normalizedName];

    if ([name hasSuffix:@"/"]) {
      NSString *dirPath = [[destPath stringByAppendingPathComponent:normalizedName] stringByStandardizingPath];
      if (![self isPath:dirPath safelyInsideDirectory:destPath]) {
        if (error)
          *error = [NSError errorWithDomain:@"BundleDrop" code:6
                                   userInfo:@{NSLocalizedDescriptionKey:
                      [NSString stringWithFormat:@"Zip entry outside target dir: %@", name]}];
        return nil;
      }
      [fm createDirectoryAtPath:dirPath withIntermediateDirectories:YES attributes:nil error:nil];
      continue;
    }

    if (localHdrOffset + 30 > length) continue;
    uint16_t localNameLen  = zipRead16(bytes + localHdrOffset + 26);
    uint16_t localExtraLen = zipRead16(bytes + localHdrOffset + 28);
    NSUInteger dataStart = localHdrOffset + 30 + localNameLen + localExtraLen;
    NSUInteger dataEnd   = dataStart + compressedSize;
    if (dataEnd > length) continue;

    NSUInteger entryOutputSize = (method == 0) ? compressedSize : uncompressedSize;
    if (entryOutputSize > maxEntrySize) {
      if (error)
        *error = [NSError errorWithDomain:@"BundleDrop" code:7
                                 userInfo:@{NSLocalizedDescriptionKey:
                    [NSString stringWithFormat:@"ZIP entry too large: %lu bytes (max %lu)",
                     (unsigned long)entryOutputSize, (unsigned long)maxEntrySize]}];
      return nil;
    }
    totalUncompressed += entryOutputSize;
    if (totalUncompressed > maxTotalUncompressed) {
      if (error)
        *error = [NSError errorWithDomain:@"BundleDrop" code:8
                                 userInfo:@{NSLocalizedDescriptionKey:
                    [NSString stringWithFormat:@"ZIP total uncompressed too large: %lu bytes (max %lu)",
                     (unsigned long)totalUncompressed, (unsigned long)maxTotalUncompressed]}];
      return nil;
    }

    NSData *fileData;
    if (method == 0) {
      fileData = [data subdataWithRange:NSMakeRange(dataStart, compressedSize)];
    } else if (method == 8) {
      fileData = [self inflateRaw:bytes + dataStart
                           length:compressedSize
                 uncompressedSize:uncompressedSize
                            error:error];
      if (!fileData) return nil;
    } else {
      if (error)
        *error = [NSError errorWithDomain:@"BundleDrop" code:2
                                 userInfo:@{NSLocalizedDescriptionKey:
                    [NSString stringWithFormat:@"Unsupported ZIP compression method: %d", method]}];
      return nil;
    }

    NSString *filePath = [[destPath stringByAppendingPathComponent:normalizedName] stringByStandardizingPath];
    if (![self isPath:filePath safelyInsideDirectory:destPath]) {
      if (error)
        *error = [NSError errorWithDomain:@"BundleDrop" code:6
                                 userInfo:@{NSLocalizedDescriptionKey:
                    [NSString stringWithFormat:@"Zip entry outside target dir: %@", name]}];
      return nil;
    }
    NSString *fileDir  = [filePath stringByDeletingLastPathComponent];
    if (![fm fileExistsAtPath:fileDir]) {
      [fm createDirectoryAtPath:fileDir withIntermediateDirectories:YES attributes:nil error:nil];
    }
    [fileData writeToFile:filePath atomically:YES];
    [filenames addObject:normalizedName];
  }

  return filenames;
}

#pragma mark - Raw DEFLATE decompression via zlib

+ (NSData *)inflateRaw:(const uint8_t *)src
                length:(NSUInteger)srcLen
      uncompressedSize:(NSUInteger)dstLen
                 error:(NSError **)error {
  if (dstLen == 0) return [NSData data];

  NSMutableData *output = [NSMutableData dataWithLength:dstLen];

  z_stream stream;
  memset(&stream, 0, sizeof(stream));
  stream.next_in   = (Bytef *)src;
  stream.avail_in  = (uInt)srcLen;
  stream.next_out  = output.mutableBytes;
  stream.avail_out = (uInt)dstLen;

  int ret = inflateInit2(&stream, -MAX_WBITS);
  if (ret != Z_OK) {
    if (error)
      *error = [NSError errorWithDomain:@"BundleDrop" code:3
                               userInfo:@{NSLocalizedDescriptionKey:
                  [NSString stringWithFormat:@"inflateInit2 failed: %d", ret]}];
    return nil;
  }

  ret = inflate(&stream, Z_FINISH);
  inflateEnd(&stream);

  if (ret != Z_STREAM_END) {
    if (error)
      *error = [NSError errorWithDomain:@"BundleDrop" code:4
                               userInfo:@{NSLocalizedDescriptionKey:
                  [NSString stringWithFormat:@"inflate failed: %d", ret]}];
    return nil;
  }

  output.length = stream.total_out;
  return output;
}

@end
