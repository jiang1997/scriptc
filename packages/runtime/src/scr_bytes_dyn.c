/* The Buffer.prototype methods of a Buffer held as a checked-dynamic value:
 * a JavaScript dependency's `buf.writeUInt32LE(v, 0)` on a buffer it got back
 * untyped (yazl), or `this.buf.write(s)` on a buffer a constructor function
 * stored. The compiler routes only the dyn method calls that name one of
 * these methods here, so programs without them link nothing new; any other
 * receiver takes the ordinary dispatch. */
#include "scr_runtime.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

static const struct {
  const char *name;
  ScrBytesNumKind kind;
  bool le;
} scr_bytes_dyn_names[] = {
  { "UInt8", SCR_BN_U8, false },     { "Uint8", SCR_BN_U8, false },
  { "Int8", SCR_BN_I8, false },      { "UInt16LE", SCR_BN_U16, true },
  { "Uint16LE", SCR_BN_U16, true },  { "UInt16BE", SCR_BN_U16, false },
  { "Uint16BE", SCR_BN_U16, false }, { "Int16LE", SCR_BN_I16, true },
  { "Int16BE", SCR_BN_I16, false },  { "UInt32LE", SCR_BN_U32, true },
  { "Uint32LE", SCR_BN_U32, true },  { "UInt32BE", SCR_BN_U32, false },
  { "Uint32BE", SCR_BN_U32, false }, { "Int32LE", SCR_BN_I32, true },
  { "Int32BE", SCR_BN_I32, false },  { "FloatLE", SCR_BN_F32, true },
  { "FloatBE", SCR_BN_F32, false },  { "DoubleLE", SCR_BN_F64, true },
  { "DoubleBE", SCR_BN_F64, false },
};

static size_t scr_bytes_dyn_width(ScrBytesNumKind kind) {
  switch (kind) {
    case SCR_BN_U8:
    case SCR_BN_I8:
      return 1;
    case SCR_BN_U16:
    case SCR_BN_I16:
      return 2;
    case SCR_BN_F64:
      return 8;
    default:
      return 4;
  }
}

/* Node's checkInt range test and message, before the offset is looked at. */
static bool scr_bytes_dyn_value_in_range(double value, size_t width, bool sign) {
  double max = sign ? exp2((double)(8 * width - 1)) - 1 : exp2((double)(8 * width)) - 1;
  double min = sign ? -exp2((double)(8 * width - 1)) : 0;
  if (!(value > max || value < min)) return true;
  char recv[48];
  scr_num_received(value, recv);
  char minb[32], maxb[32];
  scr_f64_to_str(min, minb);
  scr_f64_to_str(max, maxb);
  char msg[160];
  int mlen = snprintf(msg, sizeof msg,
                      "The value of \"value\" is out of range. It must be >= %s and <= %s. Received %s",
                      minb, maxb, recv);
  scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)mlen, "ERR_OUT_OF_RANGE");
  return false;
}

/* Node's order: a write converts the value with ToNumber and checks its
 * range, then the offset must be a number (absent means 0), then the
 * bounds. +1, or NULL with the exception pending. */
static ScrDyn *scr_bytes_dyn_num_method(ScrBytes *b, bool read, size_t at, ScrDyn *const *args,
                                        size_t argc) {
  ScrBytesNumKind kind = scr_bytes_dyn_names[at].kind;
  double value = 0;
  if (!read) {
    if (!scr_dyn_number_coerce_js(argc > 0 ? args[0] : scr_dyn_undefined(), &value)) return NULL;
    if (kind != SCR_BN_F32 && kind != SCR_BN_F64) {
      bool sign = kind == SCR_BN_I8 || kind == SCR_BN_I16 || kind == SCR_BN_I32;
      if (!scr_bytes_dyn_value_in_range(value, scr_bytes_dyn_width(kind), sign)) return NULL;
    }
  }
  size_t offset_at = read ? 0 : 1;
  double offset = 0;
  if (argc > offset_at && args[offset_at]->kind != SCR_DYN_UNDEF) {
    if (args[offset_at]->kind != SCR_DYN_NUM) {
      scr_dyn_arg_type_fail("offset", "of type number", args[offset_at]);
      return NULL;
    }
    offset = args[offset_at]->v.num;
  }
  bool le = scr_bytes_dyn_names[at].le;
  double out = read ? scr_bytes_read_num(b, offset, kind, le) : scr_bytes_write_num(b, value, offset, kind, le);
  return scr_exc_pending() ? NULL : scr_dyn_new_num(out);
}

static const ScrDyn *scr_bytes_dyn_arg(ScrDyn *const *args, size_t argc, size_t i) {
  return i < argc ? args[i] : scr_dyn_undefined();
}

static bool scr_bytes_dyn_undef(const ScrDyn *d) { return d->kind == SCR_DYN_UNDEF; }

static ScrDyn *scr_bytes_dyn_str(const char *text, size_t len) {
  ScrStr *s = scr_str_new(text, len);
  ScrDyn *out = scr_dyn_new_str(s);
  scr_str_release(s);
  return out;
}

/* Node's validateOffset: a number (ERR_INVALID_ARG_TYPE otherwise), then an
 * integer in [0, max] (ERR_OUT_OF_RANGE). */
static bool scr_bytes_dyn_offset(const ScrDyn *v, const char *name, double max, double *out) {
  if (v->kind != SCR_DYN_NUM) {
    scr_dyn_arg_type_fail(name, "of type number", v);
    return false;
  }
  if (!scr_bytes_validate_off(name, v->v.num, max)) return false;
  *out = v->v.num;
  return true;
}

/* getEncodingOps over an argument: ToString (`encoding += ''`), then the
 * canonical name in any ASCII case. +1, or NULL with the exception pending. */
static ScrStr *scr_bytes_dyn_encoding(const ScrDyn *v) {
  ScrStr *raw = scr_dyn_string_coerce_js(v);
  if (!raw) return NULL;
  ScrStr *out = scr_bytes_normalize_encoding(raw);
  scr_str_release(raw);
  return out;
}

/* Node's toInteger(n, 0) for copy's offsets: an integer stays, other finite
 * numbers in the safe range floor, everything else (NaN, ±Infinity) is 0. */
static bool scr_bytes_dyn_to_integer(const ScrDyn *v, double *out) {
  double n;
  if (!scr_dyn_number_coerce_js(v, &n)) return false;
  *out = n == n && n >= -9007199254740991.0 && n <= 9007199254740991.0 ? floor(n) : 0;
  return true;
}

/* buf.write(string[, offset[, length]][, encoding]): buffer.js's overload
 * resolution and offset checks, then the encoding, then the string type. */
static ScrDyn *scr_bytes_dyn_write(ScrBytes *b, ScrDyn *const *args, size_t argc) {
  const ScrDyn *string = scr_bytes_dyn_arg(args, argc, 0);
  const ScrDyn *offset = scr_bytes_dyn_arg(args, argc, 1);
  const ScrDyn *length = scr_bytes_dyn_arg(args, argc, 2);
  const ScrDyn *encoding = scr_bytes_dyn_arg(args, argc, 3);
  double at = 0, budget = (double)b->len;
  ScrStr *enc = NULL;
  if (scr_bytes_dyn_undef(offset)) {
    encoding = scr_dyn_undefined();
  } else if (scr_bytes_dyn_undef(length) && offset->kind == SCR_DYN_STR) {
    encoding = offset;
  } else {
    if (!scr_bytes_dyn_offset(offset, "offset", (double)b->len, &at)) return NULL;
    budget = (double)b->len - at;
    if (length->kind == SCR_DYN_STR) {
      encoding = length;
    } else if (!scr_bytes_dyn_undef(length)) {
      double n;
      if (!scr_bytes_dyn_offset(length, "length", (double)b->len, &n)) return NULL;
      if (n < budget) budget = n;
    }
  }
  if (!scr_dyn_truthy(encoding)) {
    enc = scr_str_new("utf8", 4);
  } else {
    enc = scr_bytes_dyn_encoding(encoding);
    if (!enc) return NULL;
  }
  if (string->kind != SCR_DYN_STR) {
    scr_str_release(enc);
    static const char message[] = "argument must be a string";
    scr_throw_error_msg_code(SCR_ERR_TYPE, message, sizeof message - 1, "ERR_INVALID_ARG_TYPE");
    return NULL;
  }
  double written = scr_bytes_write_str(b, string->v.str, enc, at, budget, true);
  scr_str_release(enc);
  return scr_exc_pending() ? NULL : scr_dyn_new_num(written);
}

/* Node's inspect quoting for the ERR_INVALID_ARG_VALUE render of a string:
 * single quotes unless the text has one, then double, then backticks. */
static ScrStr *scr_bytes_dyn_quoted(const ScrStr *text) {
  char quote = '\'';
  if (memchr(text->data, '\'', text->len)) quote = memchr(text->data, '"', text->len) ? '`' : '"';
  ScrJsonBuf jb;
  scr_jb_init(&jb);
  scr_jb_puts(&jb, "The argument 'value' is invalid. Received ");
  scr_jb_putc(&jb, quote);
  scr_jb_put_str(&jb, text);
  scr_jb_putc(&jb, quote);
  return scr_jb_finish(&jb);
}

/* buf.fill(value[, offset[, end]][, encoding]): buffer.js's _fill. A string
 * takes its encoding from the first string among offset and end; numbers and
 * other non-view values fill with ToUint32(value) & 255. Answers the receiver. */
static ScrDyn *scr_bytes_dyn_fill(ScrDyn *recv, ScrDyn *const *args, size_t argc) {
  ScrBytes *b = recv->v.bytes;
  const ScrDyn *value = scr_bytes_dyn_arg(args, argc, 0);
  const ScrDyn *offset = scr_bytes_dyn_arg(args, argc, 1);
  const ScrDyn *end = scr_bytes_dyn_arg(args, argc, 2);
  ScrStr *enc = NULL;
  bool whole = false;
  if (value->kind == SCR_DYN_STR) {
    const ScrDyn *encoding = scr_bytes_dyn_arg(args, argc, 3);
    if (scr_bytes_dyn_undef(offset) || offset->kind == SCR_DYN_STR) {
      encoding = offset;
      whole = true;
    } else if (end->kind == SCR_DYN_STR) {
      encoding = end;
      end = scr_dyn_undefined();
    }
    if (encoding->kind == SCR_DYN_UNDEF || encoding->kind == SCR_DYN_NULL ||
        (encoding->kind == SCR_DYN_STR && encoding->v.str->len == 0)) {
      enc = scr_str_new("utf8", 4);
    } else if (encoding->kind != SCR_DYN_STR) {
      scr_dyn_arg_type_fail("encoding", "of type string", encoding);
      return NULL;
    } else {
      enc = scr_bytes_normalize_encoding(encoding->v.str);
      if (!enc) return NULL;
    }
  }
  double from = 0, to = (double)b->len;
  if (!whole && !scr_bytes_dyn_undef(offset)) {
    if (!scr_bytes_dyn_offset(offset, "offset", 9007199254740991.0, &from) ||
        (!scr_bytes_dyn_undef(end) && !scr_bytes_dyn_offset(end, "end", (double)b->len, &to))) {
      scr_str_release(enc);
      return NULL;
    }
    if (from >= to) {
      scr_str_release(enc);
      return scr_dyn_retain(recv);
    }
  }
  ScrBytes *out;
  if (enc) {
    const ScrStr *text = value->v.str;
    ScrBytes *pattern = scr_bytes_from_str(text, enc);
    scr_str_release(enc);
    if (text->len > 0 && pattern->len == 0) {
      scr_bytes_release(pattern);
      ScrStr *message = scr_bytes_dyn_quoted(text);
      scr_throw_error_msg_code(SCR_ERR_TYPE, message->data, message->len, "ERR_INVALID_ARG_VALUE");
      scr_str_release(message);
      return NULL;
    }
    /* An empty string fills with zeros. */
    out = text->len == 0 ? scr_bytes_fill_num(b, 0, 2, from, to) : scr_bytes_fill(b, pattern, 2, from, to);
    scr_bytes_release(pattern);
  } else if (value->kind == SCR_DYN_BYTES && !value->v.bytes->is_data_view &&
             value->v.bytes->elem == SCR_BYTES_U8) {
    out = scr_bytes_fill(b, value->v.bytes, 2, from, to);
  } else {
    double n;
    if (!scr_dyn_number_coerce_js(value, &n)) return NULL;
    out = scr_bytes_fill_num(b, n, 2, from, to);
  }
  if (!out) return NULL;
  scr_bytes_release(out);
  return scr_dyn_retain(recv);
}
/* buf.toString(encoding, start, end): the window clamps to
 * [0, length] with NaN as 0, an empty window answers "" before the
 * encoding resolves, and an undefined encoding is utf8. */
static ScrDyn *scr_bytes_dyn_to_string(ScrBytes *b, ScrDyn *const *args, size_t argc) {
  const ScrDyn *encoding = scr_bytes_dyn_arg(args, argc, 0);
  const ScrDyn *start = scr_bytes_dyn_arg(args, argc, 1);
  const ScrDyn *end = scr_bytes_dyn_arg(args, argc, 2);
  double from = 0, to = (double)b->len;
  if (!scr_bytes_dyn_undef(start) && !scr_dyn_number_coerce_js(start, &from)) return NULL;
  if (!scr_bytes_dyn_undef(end) && !scr_dyn_number_coerce_js(end, &to)) return NULL;
  if (from != from) from = 0;
  if (to != to) to = 0;
  from = trunc(from);
  to = trunc(to);
  if (from >= (double)b->len || to <= from || to <= 0) return scr_bytes_dyn_str("", 0);
  ScrStr *enc = scr_bytes_dyn_undef(encoding) ? scr_str_new("utf8", 4) : scr_bytes_dyn_encoding(encoding);
  if (!enc) return NULL;
  ScrStr *text = scr_bytes_to_str_range(b, enc, from, to);
  scr_str_release(enc);
  ScrDyn *out = scr_dyn_new_str(text);
  scr_str_release(text);
  return out;
}

/* buf.toJSON(): { type: 'Buffer', data: [...bytes] }. */
static ScrDyn *scr_bytes_dyn_to_json(const ScrBytes *b) {
  ScrDyn *data = scr_dyn_new_arr();
  for (size_t i = 0; i < b->len; i++) scr_dyn_arr_push(data, scr_dyn_new_num(scr_bytes_get(b, (double)i)));
  ScrDyn *out = scr_dyn_new_obj();
  scr_dyn_obj_set(out, "type", 4, scr_bytes_dyn_str("Buffer", 6));
  scr_dyn_obj_set(out, "data", 4, data);
  return out;
}

/* buf.copy(target[, targetStart[, sourceStart[, sourceEnd]]]): buffer.js's
 * _copy offsets (toInteger, then the >= 0 and source-length checks) into a
 * Buffer or Uint8Array. Other views have no lowering here. */
static ScrDyn *scr_bytes_dyn_copy(const ScrBytes *b, ScrDyn *const *args, size_t argc) {
  const ScrDyn *target = scr_bytes_dyn_arg(args, argc, 0);
  if (target->kind != SCR_DYN_BYTES) {
    scr_dyn_arg_type_fail("target", "an instance of Buffer or Uint8Array", target);
    return NULL;
  }
  if (target->v.bytes->is_data_view || target->v.bytes->elem != SCR_BYTES_U8) {
    static const char message[] =
        "'Buffer.prototype.copy' into a view that is not a Buffer or Uint8Array on a dynamic value is not supported yet";
    scr_throw_error_msg(SCR_ERR_ERROR, message, sizeof message - 1);
    return NULL;
  }
  double offsets[3] = { 0, 0, (double)b->len };
  for (size_t i = 0; i < 3; i++) {
    const ScrDyn *v = scr_bytes_dyn_arg(args, argc, i + 1);
    if (!scr_bytes_dyn_undef(v) && !scr_bytes_dyn_to_integer(v, &offsets[i])) return NULL;
  }
  return scr_dyn_new_num(scr_bytes_copy_into(b, target->v.bytes, 3, offsets[0], offsets[1], offsets[2]));
}

/* buf.indexOf/lastIndexOf/includes(value[, byteOffset][, encoding]):
 * buffer.js's bidirectionalIndexOf. A string byteOffset is the encoding;
 * the offset clamps to the int32 range, and NaN searches everything. */
static ScrDyn *scr_bytes_dyn_index_of(const ScrBytes *b, ScrDyn *const *args, size_t argc, bool fwd,
                                      bool includes) {
  const ScrDyn *value = scr_bytes_dyn_arg(args, argc, 0);
  const ScrDyn *offset = scr_bytes_dyn_arg(args, argc, 1);
  const ScrDyn *encoding = scr_bytes_dyn_arg(args, argc, 2);
  double at = NAN;
  if (offset->kind == SCR_DYN_STR) {
    encoding = offset;
  } else if (!scr_bytes_dyn_undef(offset)) {
    if (!scr_dyn_number_coerce_js(offset, &at)) return NULL;
    if (at > 2147483647.0) at = 2147483647.0;
    else if (at < -2147483648.0) at = -2147483648.0;
  }
  double found;
  if (value->kind == SCR_DYN_NUM) {
    found = scr_bytes_index_of_num(b, value->v.num, at, fwd);
  } else {
    ScrStr *enc = NULL;
    if (!scr_bytes_dyn_undef(encoding)) {
      ScrStr *raw = scr_dyn_string_coerce_js(encoding);
      if (!raw) return NULL;
      /* An unknown encoding throws for a string needle only. */
      enc = value->kind == SCR_DYN_STR ? scr_bytes_normalize_encoding(raw) : NULL;
      scr_str_release(raw);
      if (value->kind == SCR_DYN_STR && !enc) return NULL;
    }
    if (value->kind == SCR_DYN_STR) {
      if (!enc) enc = scr_str_new("utf8", 4);
      ScrBytes *needle = scr_bytes_from_str(value->v.str, enc);
      found = scr_bytes_index_of(b, needle, at, enc->len == 7 && !memcmp(enc->data, "utf16le", 7) ? 2 : 1, fwd);
      scr_bytes_release(needle);
      scr_str_release(enc);
    } else if (value->kind == SCR_DYN_BYTES && !value->v.bytes->is_data_view &&
               value->v.bytes->elem == SCR_BYTES_U8) {
      found = scr_bytes_index_of(b, value->v.bytes, at, 1, fwd);
    } else {
      scr_dyn_arg_type_fail("value", "one of type number or string or an instance of Buffer or Uint8Array", value);
      return NULL;
    }
  }
  return includes ? scr_dyn_new_bool(found != -1) : scr_dyn_new_num(found);
}

/* Buffer.prototype members this dispatch does not run: an explicit refusal
 * instead of the "is not a function" a missing method would give. */
static bool scr_bytes_dyn_refused(const char *method) {
  static const char *const prefixes[] = { "readBig", "writeBig", "readUInt", "readUint", "readInt", "writeUInt",
                                          "writeUint", "writeInt", "readFloat", "readDouble", "writeFloat",
                                          "writeDouble" };
  static const char *const names[] = { "asciiSlice", "base64Slice", "base64urlSlice", "latin1Slice", "hexSlice",
                                       "ucs2Slice", "utf8Slice", "asciiWrite", "base64Write", "base64urlWrite",
                                       "latin1Write", "hexWrite", "ucs2Write", "utf8Write", "inspect" };
  for (size_t i = 0; i < sizeof prefixes / sizeof prefixes[0]; i++)
    if (!strncmp(method, prefixes[i], strlen(prefixes[i]))) return true;
  for (size_t i = 0; i < sizeof names / sizeof names[0]; i++)
    if (!strcmp(method, names[i])) return true;
  return false;
}

static bool scr_bytes_dyn_buffer(const ScrDyn *recv) {
  return recv->kind == SCR_DYN_BYTES && recv->buffer && !recv->v.bytes->is_data_view;
}

/* One entry per method family, so a program links only the families it
 * names: each runs its methods on a Buffer receiver and gives any other
 * receiver the ordinary dispatch. */
ScrDyn *scr_dyn_invoke_buffer_num(ScrDyn *recv, ScrDyn *callee, const char *method, ScrDyn *const *args,
                                  size_t argc, const char *what) {
  if (scr_bytes_dyn_buffer(recv)) {
    bool read = !strncmp(method, "read", 4);
    const char *rest = method + (read ? 4 : 5);
    for (size_t at = 0; at < sizeof scr_bytes_dyn_names / sizeof scr_bytes_dyn_names[0]; at++) {
      if (!strcmp(rest, scr_bytes_dyn_names[at].name)) return scr_bytes_dyn_num_method(recv->v.bytes, read, at, args, argc);
    }
  }
  return scr_dyn_invoke_prepared(recv, callee, method, args, argc, what);
}

ScrDyn *scr_dyn_invoke_buffer_write(ScrDyn *recv, ScrDyn *callee, const char *method, ScrDyn *const *args,
                                    size_t argc, const char *what) {
  if (scr_bytes_dyn_buffer(recv)) return scr_bytes_dyn_write(recv->v.bytes, args, argc);
  return scr_dyn_invoke_prepared(recv, callee, method, args, argc, what);
}

ScrDyn *scr_dyn_invoke_buffer_fill(ScrDyn *recv, ScrDyn *callee, const char *method, ScrDyn *const *args,
                                   size_t argc, const char *what) {
  if (scr_bytes_dyn_buffer(recv)) return scr_bytes_dyn_fill(recv, args, argc);
  return scr_dyn_invoke_prepared(recv, callee, method, args, argc, what);
}

ScrDyn *scr_dyn_invoke_buffer_to_string(ScrDyn *recv, ScrDyn *callee, const char *method, ScrDyn *const *args,
                                        size_t argc, const char *what) {
  if (scr_bytes_dyn_buffer(recv)) return scr_bytes_dyn_to_string(recv->v.bytes, args, argc);
  return scr_dyn_invoke_prepared(recv, callee, method, args, argc, what);
}

/* indexOf, lastIndexOf and includes. */
ScrDyn *scr_dyn_invoke_buffer_search(ScrDyn *recv, ScrDyn *callee, const char *method, ScrDyn *const *args,
                                     size_t argc, const char *what) {
  if (scr_bytes_dyn_buffer(recv)) {
    bool includes = !strcmp(method, "includes");
    return scr_bytes_dyn_index_of(recv->v.bytes, args, argc, strcmp(method, "lastIndexOf") != 0, includes);
  }
  return scr_dyn_invoke_prepared(recv, callee, method, args, argc, what);
}

/* toJSON, equals, compare, copy, swap16/32/64, and the refused members. */
ScrDyn *scr_dyn_invoke_buffer(ScrDyn *recv, ScrDyn *callee, const char *method, ScrDyn *const *args,
                              size_t argc, const char *what) {
  if (scr_bytes_dyn_buffer(recv)) {
    ScrBytes *b = recv->v.bytes;
    if (!strcmp(method, "toJSON")) return scr_bytes_dyn_to_json(b);
    if (!strcmp(method, "equals")) {
      bool same = scr_bytes_equals_chk(b, scr_bytes_dyn_arg(args, argc, 0));
      return scr_exc_pending() ? NULL : scr_dyn_new_bool(same);
    }
    if (!strcmp(method, "compare")) {
      double order = scr_bytes_compare_chk(b, scr_bytes_dyn_arg(args, argc, 0), scr_bytes_dyn_arg(args, argc, 1),
                                           scr_bytes_dyn_arg(args, argc, 2), scr_bytes_dyn_arg(args, argc, 3),
                                           scr_bytes_dyn_arg(args, argc, 4));
      return scr_exc_pending() ? NULL : scr_dyn_new_num(order);
    }
    if (!strcmp(method, "copy")) return scr_bytes_dyn_copy(b, args, argc);
    if (!strcmp(method, "swap16") || !strcmp(method, "swap32") || !strcmp(method, "swap64")) {
      ScrBytes *swapped = scr_bytes_swap(b, method[4] == '1' ? 2 : method[4] == '3' ? 4 : 8);
      if (!swapped) return NULL;
      scr_bytes_release(swapped);
      return scr_dyn_retain(recv);
    }
    if (scr_bytes_dyn_refused(method)) {
      ScrJsonBuf jb;
      scr_jb_init(&jb);
      scr_jb_puts(&jb, "'Buffer.prototype.");
      scr_jb_puts(&jb, method);
      scr_jb_puts(&jb, "' on a dynamic value is not supported yet");
      ScrStr *message = scr_jb_finish(&jb);
      scr_throw_error_msg(SCR_ERR_ERROR, message->data, message->len);
      scr_str_release(message);
      return NULL;
    }
  }
  return scr_dyn_invoke_prepared(recv, callee, method, args, argc, what);
}
