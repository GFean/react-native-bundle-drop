// src/patchImageAutoResolve.ts
import { Image as RNImage } from 'react-native';

let isPatched = false;

export function patchImageRenderToForceResolve() {
  if (isPatched || !(RNImage as any).render) return;
  isPatched = true;

  const OriginalRender = (RNImage as any).render;

  (RNImage as any).render = function (...args: any[]) {
    const props = args[0];
    const originalSource = props?.source;

    if (originalSource && originalSource.__packager_asset && typeof originalSource.uri === 'string') {
      const resolved = RNImage.resolveAssetSource(originalSource);
      if (resolved?.uri) {
        props.source = resolved;
      }
    }

    return OriginalRender.apply(this, args);
  };
}
