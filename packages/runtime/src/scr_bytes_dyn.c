/* The fixed-width read/write methods of a Buffer held as a checked-dynamic
 * value: a JavaScript dependency's `buf.writeUInt32LE(v, 0)` on a buffer it
 * got back untyped (yazl). The compiler routes only the dyn method calls
 * that name one of these methods here, so programs without them link
 * nothing new; any other receiver takes the ordinary dispatch. */
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

ScrDyn *scr_dyn_invoke_buffer_num(ScrDyn *recv, ScrDyn *callee, const char *method, ScrDyn *const *args,
                                  size_t argc, const char *what) {
  if (recv->kind == SCR_DYN_BYTES && recv->buffer && !recv->v.bytes->is_data_view) {
    bool read = !strncmp(method, "read", 4);
    const char *rest = method + (read ? 4 : 5);
    for (size_t at = 0; at < sizeof scr_bytes_dyn_names / sizeof scr_bytes_dyn_names[0]; at++) {
      if (!strcmp(rest, scr_bytes_dyn_names[at].name))
        return scr_bytes_dyn_num_method(recv->v.bytes, read, at, args, argc);
    }
  }
  return scr_dyn_invoke_prepared(recv, callee, method, args, argc, what);
}
