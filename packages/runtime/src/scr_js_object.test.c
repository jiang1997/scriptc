#include "scr_runtime.h"
#include "scr_js.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Mirrors scr_js_object.c's budgets. */
#define SHAPE_BUDGET ((size_t)1 << 16)
#define KEY_BYTES_BUDGET ((size_t)4 << 20)

/* The key_len-byte key that starts with the digits of `i`. */
static ScrStr *key_of(char *bytes, size_t key_len, size_t i) {
  memset(bytes, 'k', key_len);
  int n = snprintf(bytes, key_len + 1, "%zu", i);
  bytes[n] = 'k';
  return scr_str_new(bytes, key_len);
}

/* A one-entry object {key: n}. */
static ScrDyn *object_with(const ScrStr *key, double n) {
  ScrDyn *object = scr_dyn_new_obj();
  scr_dyn_obj_set(object, key->data, key->len, scr_dyn_new_num(n));
  return object;
}

/* Whether a load probe answers `object.key` and returns `n`. */
static bool probe_reads(ScrDyn *object, const ScrStr *key, double n) {
  ScrJsIc ic;
  memset(&ic, 0, sizeof ic);
  ScrDyn *value = scr_js_load_probe(object, key, &ic);
  if (!value) return false;
  assert(value->kind == SCR_DYN_NUM && value->v.num == n);
  scr_dyn_release(value);
  return true;
}

/* Objects with a new key each: the probes shape them until `budget` shapes
 * exist, and answer with a miss after that, while the objects stay
 * readable and earlier shapes keep serving. */
static void budget_bounds_shapes(size_t key_len, size_t budget) {
  char *bytes = malloc(key_len + 1);
  assert(bytes);
  size_t shaped = 0;
  for (size_t i = 0; i < budget + 64; i++) {
    ScrStr *key = key_of(bytes, key_len, i);
    ScrDyn *object = object_with(key, (double)i);
    if (probe_reads(object, key, (double)i)) {
      assert(shaped == i);
      shaped++;
    } else {
      /* Later probes of the object miss too; the generic read answers. */
      assert(!probe_reads(object, key, (double)i));
      ScrDyn *value = scr_dyn_obj_get(object, key->data, key->len);
      assert(value && value->kind == SCR_DYN_NUM && value->v.num == (double)i);
    }
    scr_str_release(key);
    scr_dyn_release(object);
  }
  assert(shaped == budget);

  /* A key sequence shaped before the budget ran out. */
  ScrStr *first = key_of(bytes, key_len, 0);
  ScrDyn *object = object_with(first, 7);
  assert(probe_reads(object, first, 7));

  /* A store probe that would add a new shape leaves the add to the generic
   * store; one that replaces through an existing shape still runs. */
  ScrJsIc ic;
  memset(&ic, 0, sizeof ic);
  ScrStr *added = scr_str_new("added", 5);
  ScrDyn *value = scr_dyn_new_num(8);
  assert(!scr_js_store_probe(object, added, value, &ic));
  assert(object->v.obj.len == 1);
  memset(&ic, 0, sizeof ic);
  assert(scr_js_store_probe(object, first, value, &ic));
  assert(probe_reads(object, first, 8));
  scr_dyn_release(value);
  scr_str_release(added);
  scr_str_release(first);
  scr_dyn_release(object);
  free(bytes);
}

/* Immortal objects (published graphs, shared by pointer across threads)
 * stay unshaped: probes miss, and nothing writes the shape word. */
static void immortal_objects_stay_unshaped(void) {
  ScrStr *key = scr_str_new("kept", 4);
  ScrDyn *object = object_with(key, 3);
  object->rc = SIZE_MAX;
  assert(!probe_reads(object, key, 3));
  assert(object->v.obj.shape == NULL);
  ScrJsIc ic;
  memset(&ic, 0, sizeof ic);
  ScrDyn *value = scr_dyn_new_num(4);
  assert(!scr_js_store_probe(object, key, value, &ic));
  assert(object->v.obj.shape == NULL);
  scr_dyn_release(value);
  scr_str_release(key);
}

int main(int argc, char **argv) {
  scr_init();
  immortal_objects_stay_unshaped();
  if (argc > 1 && strcmp(argv[1], "key-bytes") == 0) {
    /* 64 KiB keys spend the key-byte budget after 64 shapes. */
    size_t key_len = (size_t)64 << 10;
    budget_bounds_shapes(key_len, KEY_BYTES_BUDGET / key_len);
  } else {
    budget_bounds_shapes(8, SHAPE_BUDGET);
  }
  puts("shape budget checks passed");
  return 0;
}
