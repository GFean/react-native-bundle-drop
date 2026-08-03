#include <jni.h>

#include "bundle_drop_xdelta.h"

JNIEXPORT jboolean JNICALL
Java_com_bundledrop_BundleDropXdeltaNative_nativeSupportsXdelta(JNIEnv *env, jobject self) {
  (void)env;
  (void)self;
  return bd_xdelta_self_test() ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jstring JNICALL
Java_com_bundledrop_BundleDropXdeltaNative_nativeVersion(JNIEnv *env, jobject self) {
  (void)self;
  return (*env)->NewStringUTF(env, bd_xdelta_version());
}

JNIEXPORT jstring JNICALL
Java_com_bundledrop_BundleDropXdeltaNative_nativeApplyXdelta(
  JNIEnv *env,
  jobject self,
  jstring base_path,
  jstring patch_path,
  jstring output_path
) {
  (void)self;
  const char *base = (*env)->GetStringUTFChars(env, base_path, 0);
  const char *patch = (*env)->GetStringUTFChars(env, patch_path, 0);
  const char *output = (*env)->GetStringUTFChars(env, output_path, 0);
  char error[512] = {0};

  if (base == NULL || patch == NULL || output == NULL) {
    if (base != NULL) {
      (*env)->ReleaseStringUTFChars(env, base_path, base);
    }
    if (patch != NULL) {
      (*env)->ReleaseStringUTFChars(env, patch_path, patch);
    }
    if (output != NULL) {
      (*env)->ReleaseStringUTFChars(env, output_path, output);
    }
    return (*env)->NewStringUTF(env, "xdelta JNI string conversion failed");
  }

  int result = bd_xdelta_apply(base, patch, output, error, sizeof(error));

  (*env)->ReleaseStringUTFChars(env, base_path, base);
  (*env)->ReleaseStringUTFChars(env, patch_path, patch);
  (*env)->ReleaseStringUTFChars(env, output_path, output);

  if (result == 0) {
    return NULL;
  }
  return (*env)->NewStringUTF(env, error[0] ? error : "xdelta apply failed");
}
