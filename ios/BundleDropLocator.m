#import "BundleDropLocator.h"

#if __has_include(<BundleDrop/BundleDrop-Swift.h>)
#import <BundleDrop/BundleDrop-Swift.h>
#else
#import "BundleDrop-Swift.h"
#endif

@implementation BundleDropLocator

+ (nullable NSURL *)bundleURL
{
  return [BundleDropLocatorCore bundleURL];
}

+ (unsigned long long)fileSizeAtURL:(NSURL *)url
{
  return [BundleDropLocatorCore fileSizeAt:url];
}

@end
