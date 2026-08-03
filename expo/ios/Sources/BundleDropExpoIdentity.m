#import <Foundation/Foundation.h>
#import <ExpoModulesCore/EXAppDefines.h>
#import <React/RCTBridgeModule.h>

@interface BundleDropExpoIdentity : NSObject <RCTBridgeModule>
@end

@implementation BundleDropExpoIdentity

RCT_EXPORT_MODULE(BundleDropExpoIdentity)

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (NSDictionary<NSString *, id> *)constantsToExport
{
  NSDictionary *info = NSBundle.mainBundle.infoDictionary;
  NSString *appVersion = info[@"CFBundleShortVersionString"] ?: @"";
  NSString *appBuildVersion = info[@"CFBundleVersion"] ?: @"";
  BOOL pluginEnabled = [info[@"BundleDropExpoEnabled"] boolValue];

  return @{
    @"appVersion": appVersion,
    @"appBuildVersion": appBuildVersion,
    @"otaStartupEnabled": @(pluginEnabled && !EXAppDefines.APP_DEBUG),
  };
}

@end
