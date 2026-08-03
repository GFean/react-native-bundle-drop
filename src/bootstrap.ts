import { isIOS } from './context';
import { injectBundleDropImageResolverAsync } from './injectImageResolver';
import { patchImageRenderToForceResolve } from './patchImageAutoResolve';

// Patch early so assets bundled with the app (before OTA) still resolve on Android.
// Image.render is patched synchronously (cheap), but the manifest-based resolver
// loads asynchronously to avoid blocking the JS thread with a sync native bridge call.
if (!isIOS) {
  patchImageRenderToForceResolve();
  injectBundleDropImageResolverAsync().catch(() => {});
}
