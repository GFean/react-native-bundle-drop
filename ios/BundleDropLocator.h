#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface BundleDropLocator : NSObject

+ (nullable NSURL *)bundleURL;
+ (unsigned long long)fileSizeAtURL:(NSURL *)url NS_SWIFT_NAME(fileSize(at:));

@end

NS_ASSUME_NONNULL_END
