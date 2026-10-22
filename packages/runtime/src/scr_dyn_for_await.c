/* `for await` over a checked-dynamic value (the compiler's lowerForOfDyn in
 * its async mode). The iterator is a compiled async generator itself, the
 * value's Symbol.asyncIterator method's result, or, as for any for-await,
 * its synchronous iterator, whose values the loop then awaits. Linked only
 * by programs with such a loop. */
#include "scr_runtime.h"

#include <string.h>

static SCR_TL bool scr_for_await_sync;

/* The loop's iterator (+1), or NULL with the exception pending: V8's
 * TypeError (`spell`) for a value that is neither async nor sync iterable.
 * scr_dyn_async_iterator_was_sync answers which protocol it follows. */
ScrDyn *scr_dyn_async_iterator_open(ScrDyn *value, ScrStr *spell) {
  scr_for_await_sync = false;
  if (value->kind == SCR_DYN_TYPED_REF && value->v.typed_ref.type_key) {
    const char *key = value->v.typed_ref.type_key;
    if (!strncmp(key, "async-generator<", 16)) return scr_dyn_retain(value);
    if (!strncmp(key, "generator<", 10)) {
      scr_for_await_sync = true;
      return scr_dyn_retain(value);
    }
  }
  int kind = 0;
  ScrDyn *iterator = scr_dyn_open_iterator(value, &kind, true);
  if (kind < 0) return NULL;
  if (!iterator) {
    if (spell->len > 0) {
      scr_throw_error_msg(SCR_ERR_TYPE, spell->data, spell->len);
    } else {
      static const char message[] = "object is not async iterable";
      scr_throw_error_msg(SCR_ERR_TYPE, message, sizeof message - 1);
    }
    return NULL;
  }
  scr_for_await_sync = kind == 1;
  return iterator;
}

/* Whether the iterator the last scr_dyn_async_iterator_open returned is a
 * synchronous one. Read immediately after the open. */
bool scr_dyn_async_iterator_was_sync(void) {
  return scr_for_await_sync;
}
