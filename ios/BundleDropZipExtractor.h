#import <Foundation/Foundation.h>

@interface BundleDropZipExtractor : NSObject
+ (nullable NSArray<NSString *> *)extractZipAtPath:(nonnull NSString *)zipPath
                                       toDirectory:(nonnull NSString *)destPath
                                             error:(NSError * _Nullable * _Nullable)error;
+ (nullable NSArray<NSString *> *)extractZipAtPath:(nonnull NSString *)zipPath
                                       toDirectory:(nonnull NSString *)destPath
                                    maxZipFileSize:(NSUInteger)maxZipFileSize
                                      maxEntrySize:(NSUInteger)maxEntrySize
                              maxTotalUncompressed:(NSUInteger)maxTotalUncompressed
                                             error:(NSError * _Nullable * _Nullable)error;
@end
