/* Builtin functions called as function values in JavaScript dependencies
 * (`Buffer.byteLength.bind(Buffer)`, `var alloc = Buffer.alloc`, a stored
 * `fs.realpathSync`): the arguments arrive unchecked, so these entries apply
 * Node's argument handling before the ordinary operation. A separate unit,
 * linked only by programs that read these values. */
#include "scr_runtime.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

/* Buffer.byteLength called as a function value (`Buffer.byteLength.bind(
 * Buffer)` in truncate-utf8-bytes), with the encoding known only at run
 * time. Node's ladder: a non-string source answers its byte length or
 * throws before the encoding is read; an empty string answers 0; a falsy
 * encoding, or one getEncodingOps does not know after ToString (any ASCII
 * case), counts UTF-8. */
double scr_buffer_byte_length_value(ScrDyn *value, ScrDyn *encoding) {
  static const struct { const char *from; const char *to; } map[] = {
    {"utf8", "utf8"}, {"utf-8", "utf8"}, {"hex", "hex"},
    {"base64", "base64"}, {"base64url", "base64url"},
    {"latin1", "latin1"}, {"binary", "latin1"}, {"ascii", "ascii"},
    {"utf16le", "utf16le"}, {"utf-16le", "utf16le"},
    {"ucs2", "utf16le"}, {"ucs-2", "utf16le"},
  };
  const char *name = "utf8";
  if (value->kind == SCR_DYN_STR && value->v.str->len > 0 && scr_dyn_truthy(encoding)) {
    ScrStr *raw = scr_dyn_string_coerce_js(encoding);
    if (!raw) return 0;
    for (size_t i = 0; i < sizeof map / sizeof map[0]; i++) {
      size_t n = strlen(map[i].from);
      bool same = raw->len == n;
      for (size_t k = 0; same && k < n; k++) {
        char c = raw->data[k];
        if (c >= 'A' && c <= 'Z') c = (char)(c + ('a' - 'A'));
        same = c == map[i].from[k];
      }
      if (same) {
        name = map[i].to;
        break;
      }
    }
    scr_str_release(raw);
  }
  ScrStr *canonical = scr_str_new(name, strlen(name));
  double length = scr_buffer_byte_length_dyn(value, canonical);
  scr_str_release(canonical);
  return length;
}

/* Node's normalizeEncoding: the canonical name for a string encoding
 * (any ASCII case; null, undefined and "" read as utf8), or NULL. */
static const char *scr_bv_encoding(const ScrDyn *encoding) {
  static const struct { const char *from; const char *to; } map[] = {
    {"utf8", "utf8"}, {"utf-8", "utf8"}, {"hex", "hex"},
    {"base64", "base64"}, {"base64url", "base64url"},
    {"latin1", "latin1"}, {"binary", "latin1"}, {"ascii", "ascii"},
    {"utf16le", "utf16le"}, {"utf-16le", "utf16le"},
    {"ucs2", "utf16le"}, {"ucs-2", "utf16le"},
  };
  if (encoding->kind == SCR_DYN_UNDEF || encoding->kind == SCR_DYN_NULL) return "utf8";
  if (encoding->kind != SCR_DYN_STR) return NULL;
  const ScrStr *name = encoding->v.str;
  if (name->len == 0) return "utf8";
  for (size_t i = 0; i < sizeof map / sizeof map[0]; i++) {
    size_t n = strlen(map[i].from);
    bool same = name->len == n;
    for (size_t k = 0; same && k < n; k++) {
      char c = name->data[k];
      if (c >= 'A' && c <= 'Z') c = (char)(c + ('a' - 'A'));
      same = c == map[i].from[k];
    }
    if (same) return map[i].to;
  }
  return NULL;
}

static void scr_bv_invalid_value(const ScrDyn *value) {
  char rendered[160];
  /* The rejected views are empty, which util.inspect prints whole. */
  const char *text = value->kind == SCR_DYN_BYTES && value->v.bytes->len == 0 && value->buffer ? "<Buffer >"
                     : scr_dyn_inspect_lite(value, rendered, sizeof rendered);
  char message[224];
  int n = snprintf(message, sizeof message, "The argument 'value' is invalid. Received %s", text);
  scr_throw_error_msg_code(SCR_ERR_TYPE, message, (size_t)n, "ERR_INVALID_ARG_VALUE");
}

/* Buffer.alloc called as a function value (`var alloc = Buffer.alloc` in
 * tar-stream), with Node's alloc and _fill: the size must be a number,
 * ERR_INVALID_ARG_TYPE otherwise, then the allocation and range checks.
 * A fill that is undefined or 0, or a size of 0, leaves the buffer zeroed.
 * A string fill encodes with the encoding (ERR_INVALID_ARG_TYPE for a
 * non-string encoding Node cannot normalize, ERR_UNKNOWN_ENCODING for an
 * unknown name), an empty string zero-fills, and a non-empty string that
 * encodes to no bytes throws ERR_INVALID_ARG_VALUE. A view fills with
 * its bytes (ERR_INVALID_ARG_VALUE when it is empty); any other value
 * fills with ToUint32(ToNumber(value)) & 255. +1, or NULL with the
 * exception pending. */
ScrBytes *scr_buffer_alloc_value(const ScrDyn *size, const ScrDyn *fill, const ScrDyn *encoding) {
  if (size->kind != SCR_DYN_NUM) {
    scr_dyn_arg_type_fail("size", "of type number", size);
    return NULL;
  }
  ScrBytes *buf = scr_buffer_alloc(size->v.num);
  if (!buf) return NULL;
  if (fill->kind == SCR_DYN_UNDEF || (fill->kind == SCR_DYN_NUM && fill->v.num == 0) || buf->len == 0)
    return buf;
  if (fill->kind == SCR_DYN_STR) {
    const char *name = scr_bv_encoding(encoding);
    if (!name) {
      if (encoding->kind != SCR_DYN_STR) {
        scr_dyn_arg_type_fail("encoding", "of type string", encoding);
      } else {
        ScrJsonBuf b;
        scr_jb_init(&b);
        scr_jb_puts(&b, "Unknown encoding: ");
        scr_jb_put_str(&b, encoding->v.str);
        ScrStr *message = scr_jb_finish(&b);
        scr_throw_error_msg_code(SCR_ERR_TYPE, message->data, message->len, "ERR_UNKNOWN_ENCODING");
        scr_str_release(message);
      }
      scr_bytes_release(buf);
      return NULL;
    }
    if (fill->v.str->len == 0) return buf;
    ScrStr *canonical = scr_str_new(name, strlen(name));
    ScrBytes *pattern = scr_bytes_from_str(fill->v.str, canonical);
    scr_str_release(canonical);
    if (!pattern || pattern->len == 0) {
      scr_bytes_release(pattern);
      scr_bytes_release(buf);
      scr_bv_invalid_value(fill);
      return NULL;
    }
    ScrBytes *filled = scr_bytes_fill(buf, pattern, 0, 0, 0);
    scr_bytes_release(pattern);
    scr_bytes_release(filled);
    return buf;
  }
  if (fill->kind == SCR_DYN_BYTES) {
    ScrBytes *pattern = scr_bytes_buffer_source(fill);
    if (!pattern || pattern->len == 0) {
      scr_bytes_release(pattern);
      scr_bytes_release(buf);
      scr_bv_invalid_value(fill);
      return NULL;
    }
    ScrBytes *filled = scr_bytes_fill(buf, pattern, 0, 0, 0);
    scr_bytes_release(pattern);
    scr_bytes_release(filled);
    return buf;
  }
  double value;
  if (!scr_dyn_number_coerce_js(fill, &value)) {
    scr_bytes_release(buf);
    return NULL;
  }
  double byte = isfinite(value) ? fmod(trunc(value), 256.0) : 0;
  if (byte < 0) byte += 256;
  memset(buf->data, (int)byte, buf->len);
  return buf;
}

/* fs.realpathSync and fs.realpathSync.native called as function values
 * (fs.realpath keeps `var origRealpathSync = fs.realpathSync`). Node's
 * argument handling: options that are null, undefined or a function mean
 * none, a string is the encoding, an object supplies `encoding`, anything
 * else throws ERR_INVALID_ARG_TYPE; a file URL is its path (toPathIfFileURL,
 * with fileURLToPath's errors for other URLs). The JavaScript form converts
 * any other path that is not a string with ToString (a Buffer decodes as
 * UTF-8); the native form takes a Uint8Array's bytes and throws
 * ERR_INVALID_ARG_TYPE for other values. The result is a string for
 * utf8, a Buffer for "buffer", and the UTF-8 bytes decoded in any other
 * encoding, whose name must be one Node knows. +1 or NULL. */
ScrDyn *scr_fs_realpath_value(const ScrDyn *path, const ScrDyn *options, bool native) {
  const ScrDyn *encoding = NULL;
  if (options->kind == SCR_DYN_STR) {
    encoding = options;
  } else if (options->kind == SCR_DYN_OBJ) {
    encoding = scr_dyn_obj_get(options, "encoding", 8);
  } else if (options->kind != SCR_DYN_UNDEF && options->kind != SCR_DYN_NULL &&
             options->kind != SCR_DYN_FUNC) {
    scr_dyn_arg_type_fail("options", "of type string or an instance of Object", options);
    return NULL;
  }
  static const struct { const char *from; const char *to; } names[] = {
    {"utf8", "utf8"}, {"utf-8", "utf8"}, {"hex", "hex"}, {"base64", "base64"},
    {"base64url", "base64url"}, {"latin1", "latin1"}, {"binary", "latin1"},
    {"ascii", "ascii"}, {"utf16le", "utf16le"}, {"utf-16le", "utf16le"},
    {"ucs2", "utf16le"}, {"ucs-2", "utf16le"}, {"buffer", "buffer"},
  };
  const char *canonical = "utf8";
  if (encoding && encoding->kind != SCR_DYN_UNDEF && encoding->kind != SCR_DYN_NULL &&
      !(encoding->kind == SCR_DYN_STR && encoding->v.str->len == 0)) {
    const char *found = NULL;
    if (encoding->kind == SCR_DYN_STR) {
      for (size_t i = 0; i < sizeof names / sizeof names[0] && !found; i++) {
        size_t n = strlen(names[i].from);
        if (encoding->v.str->len != n) continue;
        bool same = true;
        for (size_t k = 0; k < n && same; k++) {
          char c = encoding->v.str->data[k];
          if (c >= 'A' && c <= 'Z') c = (char)(c + ('a' - 'A'));
          same = c == names[i].from[k];
        }
        if (same) found = names[i].to;
      }
    }
    if (!found) {
      ScrStr *shown = scr_dyn_string_coerce_js(encoding);
      if (!shown) return NULL;
      char msg[256];
      int n = snprintf(msg, sizeof msg, "The argument 'encoding' is invalid encoding. Received '%.*s'",
                       (int)(shown->len > 160 ? 160 : shown->len), shown->data);
      scr_str_release(shown);
      scr_throw_error_msg_code(SCR_ERR_TYPE, msg, (size_t)n, "ERR_INVALID_ARG_VALUE");
      return NULL;
    }
    canonical = found;
  }
  ScrStr *p;
  if (scr_dyn_native_url_is(path)) {
    p = scr_url_to_path(path->v.handle.ptr);
  } else if (path->kind == SCR_DYN_STR) {
    p = scr_str_retain(path->v.str);
  } else if (native && path->kind == SCR_DYN_BYTES && path->v.bytes->elem == SCR_BYTES_U8) {
    /* getValidatedPath takes a Uint8Array's bytes as the path. */
    ScrStr *utf8 = scr_str_new("utf8", 4);
    p = scr_bytes_to_str(path->v.bytes, utf8);
    scr_str_release(utf8);
  } else if (native) {
    scr_dyn_arg_type_fail("path", "of type string or an instance of Buffer or URL", path);
    return NULL;
  } else {
    p = scr_dyn_string_coerce_js(path);
  }
  if (!p) return NULL;
  ScrStr *resolved = native ? scr_fs_realpath_promise(p) : scr_fs_realpath(p);
  scr_str_release(p);
  if (!resolved) return NULL;
  ScrDyn *out;
  if (!strcmp(canonical, "utf8")) {
    out = scr_dyn_new_str(resolved);
  } else {
    ScrStr *utf8 = scr_str_new("utf8", 4);
    ScrBytes *bytes = scr_buffer_from_str(resolved, utf8);
    scr_str_release(utf8);
    if (!strcmp(canonical, "buffer")) {
      out = scr_dyn_new_buffer(bytes);
    } else {
      ScrStr *enc = scr_str_new(canonical, strlen(canonical));
      ScrStr *text = scr_bytes_to_str(bytes, enc);
      scr_str_release(enc);
      out = scr_dyn_new_str(text);
      scr_str_release(text);
    }
    scr_bytes_release(bytes);
  }
  scr_str_release(resolved);
  return out;
}
