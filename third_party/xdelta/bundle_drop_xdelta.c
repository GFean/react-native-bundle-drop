#include "bundle_drop_xdelta.h"

#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>

#include "xdelta3/xdelta3.h"

#define BD_XDELTA_INPUT_BUFFER_SIZE (64U * 1024U)
#define BD_XDELTA_SOURCE_BLOCK_SIZE (64U * 1024U)
#define BD_XDELTA_MAX_OUTPUT_BYTES (512ULL * 1024ULL * 1024ULL)

typedef struct {
  FILE *source_file;
  uint8_t source_buffer[BD_XDELTA_SOURCE_BLOCK_SIZE];
} bd_xdelta_source_context;

static void bd_xdelta_set_error(char *buffer, size_t len, const char *message) {
  if (buffer == NULL || len == 0) {
    return;
  }
  if (message == NULL) {
    message = "xdelta error";
  }
  snprintf(buffer, len, "%s", message);
}

static const char *bd_xdelta_error_message(xd3_stream *stream, int ret) {
  if (stream != NULL && stream->msg != NULL) {
    return stream->msg;
  }
  const char *message = xd3_strerror(ret);
  return message != NULL ? message : "xdelta decode failed";
}

static int bd_xdelta_source_size(const char *path, xoff_t *size_out) {
  struct stat st;
  if (stat(path, &st) != 0) {
    return errno != 0 ? errno : EIO;
  }
  if (st.st_size < 0) {
    return EINVAL;
  }
  *size_out = (xoff_t)st.st_size;
  return 0;
}

static int bd_xdelta_getblk(xd3_stream *stream, xd3_source *source, xoff_t blkno) {
  (void)stream;
  bd_xdelta_source_context *context = (bd_xdelta_source_context *)source->ioh;
  if (context == NULL || context->source_file == NULL) {
    return EINVAL;
  }

  xoff_t offset = blkno * (xoff_t)source->blksize;
  if (fseeko(context->source_file, (off_t)offset, SEEK_SET) != 0) {
    return errno != 0 ? errno : EIO;
  }

  size_t bytes_read = fread(context->source_buffer, 1, source->blksize, context->source_file);
  if (ferror(context->source_file)) {
    return errno != 0 ? errno : EIO;
  }

  source->curblkno = blkno;
  source->onblk = (usize_t)bytes_read;
  source->curblk = context->source_buffer;
  return 0;
}

int bd_xdelta_apply(
  const char *base_path,
  const char *patch_path,
  const char *output_path,
  char *error_buffer,
  size_t error_buffer_len
) {
  if (base_path == NULL || patch_path == NULL || output_path == NULL) {
    bd_xdelta_set_error(error_buffer, error_buffer_len, "xdelta paths must not be null");
    return -1;
  }

  FILE *base_file = NULL;
  FILE *patch_file = NULL;
  FILE *output_file = NULL;
  xd3_stream stream;
  xd3_config config;
  xd3_source source;
  bd_xdelta_source_context source_context;
  uint8_t input_buffer[BD_XDELTA_INPUT_BUFFER_SIZE];
  uint64_t total_output = 0;
  xoff_t source_size = 0;
  int result = -1;

  memset(&stream, 0, sizeof(stream));
  memset(&config, 0, sizeof(config));
  memset(&source, 0, sizeof(source));
  memset(&source_context, 0, sizeof(source_context));

  int stat_error = bd_xdelta_source_size(base_path, &source_size);
  if (stat_error != 0) {
    bd_xdelta_set_error(error_buffer, error_buffer_len, "failed to stat xdelta base file");
    goto cleanup;
  }

  base_file = fopen(base_path, "rb");
  if (base_file == NULL) {
    bd_xdelta_set_error(error_buffer, error_buffer_len, "failed to open xdelta base file");
    goto cleanup;
  }
  patch_file = fopen(patch_path, "rb");
  if (patch_file == NULL) {
    bd_xdelta_set_error(error_buffer, error_buffer_len, "failed to open xdelta patch file");
    goto cleanup;
  }
  output_file = fopen(output_path, "wb");
  if (output_file == NULL) {
    bd_xdelta_set_error(error_buffer, error_buffer_len, "failed to open xdelta output file");
    goto cleanup;
  }

  source_context.source_file = base_file;
  source.blksize = BD_XDELTA_SOURCE_BLOCK_SIZE;
  source.name = base_path;
  source.ioh = &source_context;
  source.max_winsize = XD3_DEFAULT_SRCWINSZ;

  xd3_init_config(&config, XD3_ADLER32_NOVER);
  config.winsize = XD3_DEFAULT_WINSIZE;
  config.getblk = bd_xdelta_getblk;

  int ret = xd3_config_stream(&stream, &config);
  if (ret != 0) {
    bd_xdelta_set_error(error_buffer, error_buffer_len, bd_xdelta_error_message(&stream, ret));
    goto cleanup;
  }

  ret = xd3_set_source_and_size(&stream, &source, source_size);
  if (ret != 0) {
    bd_xdelta_set_error(error_buffer, error_buffer_len, bd_xdelta_error_message(&stream, ret));
    goto cleanup;
  }

  size_t bytes_read;
  do {
    bytes_read = fread(input_buffer, 1, sizeof(input_buffer), patch_file);
    if (ferror(patch_file)) {
      bd_xdelta_set_error(error_buffer, error_buffer_len, "failed to read xdelta patch file");
      goto cleanup;
    }
    if (bytes_read < sizeof(input_buffer)) {
      stream.flags |= XD3_FLUSH;
    }

    xd3_avail_input(&stream, input_buffer, (usize_t)bytes_read);

    for (;;) {
      ret = xd3_decode_input(&stream);
      if (ret == XD3_INPUT) {
        break;
      }
      if (ret == XD3_GOTHEADER || ret == XD3_WINSTART || ret == XD3_WINFINISH) {
        continue;
      }
      if (ret == XD3_OUTPUT) {
        if (total_output + stream.avail_out > BD_XDELTA_MAX_OUTPUT_BYTES) {
          bd_xdelta_set_error(error_buffer, error_buffer_len, "xdelta output exceeds safety limit");
          goto cleanup;
        }
        if (fwrite(stream.next_out, 1, stream.avail_out, output_file) != stream.avail_out) {
          bd_xdelta_set_error(error_buffer, error_buffer_len, "failed to write xdelta output file");
          goto cleanup;
        }
        total_output += stream.avail_out;
        xd3_consume_output(&stream);
        continue;
      }

      bd_xdelta_set_error(error_buffer, error_buffer_len, bd_xdelta_error_message(&stream, ret));
      goto cleanup;
    }
  } while (bytes_read == sizeof(input_buffer));

  ret = xd3_close_stream(&stream);
  if (ret != 0) {
    bd_xdelta_set_error(error_buffer, error_buffer_len, bd_xdelta_error_message(&stream, ret));
    goto cleanup;
  }

  if (fflush(output_file) != 0) {
    bd_xdelta_set_error(error_buffer, error_buffer_len, "failed to flush xdelta output file");
    goto cleanup;
  }

  result = 0;

cleanup:
  if (result != 0) {
    xd3_abort_stream(&stream);
  }
  xd3_free_stream(&stream);
  if (output_file != NULL) {
    fclose(output_file);
  }
  if (patch_file != NULL) {
    fclose(patch_file);
  }
  if (base_file != NULL) {
    fclose(base_file);
  }
  if (result != 0) {
    remove(output_path);
  }
  return result;
}

int bd_xdelta_self_test(void) {
  static const uint8_t base[] = "Bundle Drop xdelta base fixture\nline one\n";
  static const uint8_t expected[] = "Bundle Drop xdelta target fixture\nline two\n";
  static const uint8_t patch[] = {
    0xd6, 0xc3, 0xc4, 0x00, 0x04, 0x15, 0x74, 0x61, 0x72, 0x67, 0x65, 0x74,
    0x2e, 0x74, 0x78, 0x74, 0x2f, 0x2f, 0x62, 0x61, 0x73, 0x65, 0x2e, 0x74,
    0x78, 0x74, 0x2f, 0x05, 0x25, 0x00, 0x1a, 0x2b, 0x00, 0x0a, 0x05, 0x02,
    0x5d, 0x5e, 0x0f, 0xb6, 0x74, 0x61, 0x72, 0x67, 0x65, 0x74, 0x74, 0x77,
    0x6f, 0x0a, 0x13, 0x13, 0x07, 0x1e, 0x05, 0x00, 0x17
  };
  uint8_t output[sizeof(expected)];
  usize_t output_size = sizeof(output);
  int ret = xd3_decode_memory(
    patch,
    (usize_t)sizeof(patch),
    base,
    (usize_t)(sizeof(base) - 1),
    output,
    &output_size,
    (usize_t)sizeof(output),
    XD3_ADLER32_NOVER
  );
  if (ret != 0) {
    return 0;
  }
  if (output_size != sizeof(expected) - 1) {
    return 0;
  }
  return memcmp(output, expected, sizeof(expected) - 1) == 0 ? 1 : 0;
}

const char *bd_xdelta_version(void) {
  return "xdelta 3.1.1-apl release3_1_apl 7508fd2a823443b1f0173ca361620f21d62a7d37";
}
