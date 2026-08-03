#ifndef BUNDLE_DROP_XDELTA_CONFIG_H
#define BUNDLE_DROP_XDELTA_CONFIG_H

#if !defined(__cplusplus) && !defined(static_assert)
#define static_assert _Static_assert
#endif

#define SIZEOF_UNSIGNED_INT 4
#define SIZEOF_UNSIGNED_LONG_LONG 8

#if defined(__LP64__) || defined(_WIN64)
#define SIZEOF_SIZE_T 8
#define SIZEOF_UNSIGNED_LONG 8
#else
#define SIZEOF_SIZE_T 4
#define SIZEOF_UNSIGNED_LONG 4
#endif

#define XD3_MAIN 0
#define XD3_ENCODER 0
#define REGRESSION_TEST 0
#define NOT_MAIN 0
#define PYTHON_MODULE 0
#define SWIG_MODULE 0
#define SECONDARY_DJW 0
#define SECONDARY_FGK 0
#define SECONDARY_LZMA 0

#define XD3_HARDMAXWINSIZE (1U << 26)
#define XD3_DEFAULT_WINSIZE (1U << 20)
#define XD3_DEFAULT_SRCWINSZ (1U << 26)
#define XD3_DEFAULT_IOPT_SIZE (1U << 15)

#endif
