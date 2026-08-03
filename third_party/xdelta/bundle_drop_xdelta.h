#ifndef BUNDLE_DROP_XDELTA_H
#define BUNDLE_DROP_XDELTA_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

int bd_xdelta_apply(
  const char *base_path,
  const char *patch_path,
  const char *output_path,
  char *error_buffer,
  size_t error_buffer_len
);

int bd_xdelta_self_test(void);

const char *bd_xdelta_version(void);

#ifdef __cplusplus
}
#endif

#endif
