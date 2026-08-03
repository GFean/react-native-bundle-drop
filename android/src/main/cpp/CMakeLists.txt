cmake_minimum_required(VERSION 3.18.1)

project(bundledropxdelta C)

set(XDELTA_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../../../third_party/xdelta")

add_library(
  bundledropxdelta
  SHARED
  bundle_drop_xdelta_jni.c
  "${XDELTA_ROOT}/bundle_drop_xdelta.c"
  "${XDELTA_ROOT}/xdelta3/xdelta3.c"
)

target_include_directories(
  bundledropxdelta
  PRIVATE
  "${XDELTA_ROOT}"
  "${XDELTA_ROOT}/xdelta3"
)

set_target_properties(
  bundledropxdelta
  PROPERTIES
  C_STANDARD 11
  C_STANDARD_REQUIRED ON
)

# Force 16 KB ELF segment alignment on this shared library. Google Play rejects
# apps whose native libraries are not 16 KB page-size compatible on Android 15+
# devices. Setting the flags directly on the target is reliable across NDK
# versions; the ANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES gradle argument alone does
# not consistently reach this target's link line on NDK r27 and lower.
target_link_options(
  bundledropxdelta
  PRIVATE
  "-Wl,-z,max-page-size=16384"
  "-Wl,-z,common-page-size=16384"
)

target_compile_definitions(
  bundledropxdelta
  PRIVATE
  HAVE_CONFIG_H=1
)
