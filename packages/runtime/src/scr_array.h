/* scriptc runtime — arrays and Math over arrays (scr_array.c). Included by
 * scr_runtime.h, which says where new declarations go. */
#ifndef SCR_ARRAY_H
#define SCR_ARRAY_H

#include "scr_qs.h"

/* ── arrays ─────────────────────────────────────────────────────────
 * Monomorphic, growable, refcounted. Elements live in 8-byte slots
 * (doubles/pointers via memcpy and casts), except SCR_ELEM_BOOL, whose
 * dense storage holds one byte (0 or 1) per element; `elem` records what
 * the slots hold so the array can release its own reference elements — ScrStr's
 * layout is untouched (interned-literal statics depend on it), so the
 * element kind lives here instead of in a shared object header. A separate
 * presence bitset distinguishes a hole from a present `undefined`-carrying
 * reference value. Very large indices stay in a sorted sparse side store;
 * the dense slot array is retained for ordinary packed arrays.
 *
 * Index arguments are doubles (JS numbers). A valid array index is a
 * non-negative integer below 2^32-1; reads must be < len and writes may
 * extend len through a sparse hole. Noncanonical numeric keys are ordinary
 * properties stored by their JavaScript number-to-string spelling. Anything
 * else prints
 *   scriptc: RangeError: array index <i> out of bounds (length <n>)
 * to stderr and abort()s in the proven-presence accessors. `scr_arr_has` is
 * the shared presence query used before those accessors when the language
 * surface permits an undefined result.
 *
 * Ownership: _get_ref returns +1 (retains before returning); _set_ref and
 * _push_ref take ownership of the new element (and _set_ref releases the
 * old one); _pop_ref transfers the element's reference out to the caller.
 */

typedef enum {
  SCR_ELEM_F64,
  SCR_ELEM_BOOL,
  SCR_ELEM_STR, /* slots are ScrStr* — released with the array */
  SCR_ELEM_ARR, /* slots are ScrArr* — released recursively */
  SCR_ELEM_BYTES, /* slots are ScrBytes* — released with the array */
  /* Slots are void* to values the runtime cannot lay out itself — records,
   * class instances, unions, and cycle-capable inner arrays. The element
   * type's RC entry points arrive at construction (scr_arr_new_ops) as one
   * constant descriptor per element type, stored once per array; every
   * array is still monomorphic (one element type, one set of entry points). */
  SCR_ELEM_REF,
} ScrElemKind;

typedef enum {
  SCR_ARR_HOLE = 0,
  SCR_ARR_VALUE = 1,
  SCR_ARR_UNDEFINED = 2,
} ScrArrState;

/* The RC entry points of an SCR_ELEM_REF array's element type: one constant
 * per element type (emitted by the compiler, or static in the runtime),
 * shared by every array of that type. retain/release are the type's `_v`
 * adapters; trace is non-NULL exactly when the element type carries a cycle
 * header. */
typedef struct ScrArrOps {
  void *(*retain)(void *);
  void (*release)(void *);
  ScrTraceFn trace;
} ScrArrOps;

typedef struct ScrArr {
  size_t rc; /* SIZE_MAX = immortal (unused for arrays; kept per convention) */
  /* Length and dense capacity are at most SCR_ARR_MAX_LENGTH (2^32 - 1);
   * sparse entries cover indices >= cap. */
  uint32_t len;
  uint32_t cap;
  /* One ScrElemKind. */
  uint8_t elem;
  /* 1 exactly when ops->trace is non-NULL: the element type carries a cycle
   * header, so the array is CYCLE-CAPABLE (an element can point back at the
   * array that owns it) and allocates with the hidden collector header —
   * its trace visits every element, and the collector teardown frees only
   * the slot storage (all elements are traced children). Arrays of acyclic
   * ref elements and the historic element kinds keep the lean 1-word
   * header. Kept beside `elem` so the RC fast paths test it with one load. */
  uint8_t cyc;
  /* Storage flags private to scr_array.c (inline slots, head room). */
  uint16_t spare;
  /* A lower bound on the hole-free prefix: filled <= len, filled <= cap,
   * and every dense state below it is SCR_ARR_VALUE. Element reads below
   * it need no state check and element writes below it leave the states
   * alone. Any operation that may store another state (a hole, present
   * undefined) or move states below it lowers it first (scr_arr_cut);
   * 0 is always valid. */
  uint32_t filled;
  /* SCR_ELEM_REF only; NULL for every other element kind. */
  const ScrArrOps *ops;
  /* Dense values: `cap` 8-byte slots, or `cap` bytes for SCR_ELEM_BOOL
   * (scr_arr_slot_width), followed in the same allocation by one state byte
   * per slot in reverse slot order (scr_arr_states_end). Sparse entries and properties keep 8-byte
   * slots for every kind; a bool slot is 0 or 1 wherever it lives. */
  uint64_t *data;
  /* Rarely used storage (sparse indices, noncanonical numeric properties,
   * match-result metadata) lives out of line: NULL until first needed, so
   * the common dense array stays small. */
  struct ScrArrExt *ext;
} ScrArr;

typedef struct ScrArrExt {
  struct ScrArrSparseSlot *sparse;
  size_t sparse_len;
  size_t sparse_cap;
  struct ScrArrProp *props; /* noncanonical numeric properties */
  size_t prop_len;
  size_t prop_cap;
  /* Heterogeneous named properties of match results. Until a result's
   * metadata is first needed, this is the match source handle that the
   * results of one exec or matchAll call share (SCR_DYNH_MATCH_SOURCE,
   * scr_regex.c), and match_index is the result's UTF-16 start index. */
  struct ScrDyn *metadata;
  double match_index;
} ScrArrExt;
/* The LLVM backend mirrors ScrArr as %ScrArr: its inline retain/release read
 * `cyc` (field 4, i8) to decide mark-live / candidate buffering exactly like
 * scr_arr_retain and scr_arr_release; its inline element access uses len and
 * cap (fields 1 and 2, i32), filled (field 6, i32) and data (field 8), and
 * finds the state of slot i at data + cap * (slot width + 1) - 1 - i. */
_Static_assert(offsetof(ScrArr, len) == sizeof(size_t) && sizeof(((ScrArr *)0)->len) == 4,
               "emitted length reads load ScrArr.len as %ScrArr field 1, an i32");
_Static_assert(offsetof(ScrArr, cap) == sizeof(size_t) + 4 && sizeof(((ScrArr *)0)->cap) == 4,
               "emitted capacity reads load ScrArr.cap as %ScrArr field 2, an i32");
_Static_assert(offsetof(ScrArr, cyc) == sizeof(size_t) + 9,
               "inline RC fast paths read ScrArr.cyc as %ScrArr field 4");
_Static_assert(offsetof(ScrArr, filled) == sizeof(size_t) + 12,
               "inline element access reads ScrArr.filled as %ScrArr field 6");
_Static_assert(offsetof(ScrArr, data) == sizeof(size_t) + 16 + sizeof(void *),
               "inline element reads use ScrArr.data as %ScrArr field 8");
_Static_assert(sizeof(ScrArr) == sizeof(size_t) + 16 + 3 * sizeof(void *),
               "ScrArr is 48 bytes on 64-bit targets");

/* Bytes per dense value slot. */
static inline size_t scr_arr_slot_width(const ScrArr *a) {
  return a->elem == SCR_ELEM_BOOL ? 1 : sizeof(uint64_t);
}

/* The dense states, one byte per slot, share the values' allocation (inline
 * slots included). They follow the `cap` value slots in reverse slot order:
 * the state of slot i is the byte i + 1 before scr_arr_states_end(a). Removing
 * slots from the front (head room: `data` advances, `cap` drops) leaves every
 * remaining state at its address. The address is computed on integers, so a
 * NULL `data` stays NULL. */
static inline uint8_t *scr_arr_states_end(const ScrArr *a) {
  return (uint8_t *)((uintptr_t)a->data + (uintptr_t)a->cap * (scr_arr_slot_width(a) + 1));
}

/* scr_arr_states_end for an array whose slots are known to be `width`
 * bytes wide: a constant multiple, with no element-kind test. */
static inline uint8_t *scr_arr_states_end_w(const ScrArr *a, size_t width) {
  return (uint8_t *)((uintptr_t)a->data + (uintptr_t)a->cap * (width + 1));
}

/* The state of dense slot `index` (< cap), given the end of the states. */
static inline uint8_t *scr_arr_state_in(const uint8_t *end, size_t index) {
  return (uint8_t *)end - 1 - index;
}

static inline uint8_t *scr_arr_state_ptr(const ScrArr *a, size_t index) {
  return scr_arr_state_in(scr_arr_states_end(a), index);
}

/* The states of dense slots [from, from + count) are contiguous, in reverse
 * order; this is their first byte (the state of slot from + count - 1). */
static inline uint8_t *scr_arr_state_run(const ScrArr *a, size_t from, size_t count) {
  return scr_arr_states_end(a) - from - count;
}

/* The dense value at `index` (< cap) as an 8-byte slot, and its store. */
static inline uint64_t scr_arr_dense_get(const ScrArr *a, size_t index) {
  if (a->elem == SCR_ELEM_BOOL) return ((const uint8_t *)a->data)[index];
  return a->data[index];
}

static inline void scr_arr_dense_put(ScrArr *a, size_t index, uint64_t slot) {
  if (a->elem == SCR_ELEM_BOOL) ((uint8_t *)a->data)[index] = (uint8_t)slot;
  else a->data[index] = slot;
}

/* Lower the hole-free prefix to at most `index`: call before storing a
 * non-value state at `index`, or before moving states into [index, ...). */
static inline void scr_arr_cut(ScrArr *a, size_t index) {
  if (a->filled > index) a->filled = (uint32_t)index;
}

/* The first index in [f, end) whose state is not a present value (or end),
 * given the end of the states. Compares eight states per step: bulk copies
 * (slice, concat, spread) end with this scan over the whole copied range. */
static inline size_t scr_arr_value_run(const uint8_t *states_end, size_t f, size_t end) {
  const uint64_t values = 0x0101010101010101ull * SCR_ARR_VALUE;
  while (end - f >= 8) {
    uint64_t word;
    memcpy(&word, states_end - f - 8, sizeof word);
    if (word != values) break;
    f += 8;
  }
  while (f < end && *scr_arr_state_in(states_end, f) == SCR_ARR_VALUE) f++;
  return f;
}

/* Extend the hole-free prefix over populated dense states. Starts at the
 * current bound, so after an append it costs only the appended range. */
static inline void scr_arr_refill(ScrArr *a) {
  size_t end = a->len < a->cap ? a->len : a->cap;
  size_t f = a->filled;
  if (f < end) f = scr_arr_value_run(scr_arr_states_end(a), f, end);
  a->filled = (uint32_t)f;
}

typedef struct ScrArrSparseSlot {
  size_t index;
  uint64_t slot;
  uint8_t state;
} ScrArrSparseSlot;

typedef struct ScrArrProp {
  char *key;
  size_t key_len;
  uint64_t slot;
  uint8_t state; /* SCR_ARR_VALUE or SCR_ARR_UNDEFINED */
} ScrArrProp;

ScrArr *scr_arr_new(ScrElemKind elem, size_t initial_cap); /* returns +1 */

/* SCR_ELEM_REF construction: `ops` must outlive the array (a constant; the
 * compiler emits one per element type) and its retain/release must be
 * non-NULL; ops->trace is non-NULL iff the element type carries a cycle
 * header (the array then allocates with the collector header — see the
 * struct comment). Returns +1. */
ScrArr *scr_arr_new_ops(const ScrArrOps *ops, size_t initial_cap);
/* An empty array expected to receive a few elements: its first slots live
 * in the array's own block (one allocation; the block of a plain empty
 * array plus five 8-byte slots). Otherwise exactly scr_arr_new(elem, 0) and
 * scr_arr_new_ops(ops, 0). Returns +1. */
ScrArr *scr_arr_new_small(ScrElemKind elem);
ScrArr *scr_arr_new_ops_small(const ScrArrOps *ops);
/* scr_arr_new(elem, cap) for a known final length: the `cap` slots share
 * the array's own block (one allocation). Returns +1. */
ScrArr *scr_arr_new_inline(ScrElemKind elem, size_t cap);

static inline ScrArr *scr_arr_retain(ScrArr *a) {
  if (a->rc != SIZE_MAX) {
    a->rc++;
  }
  return a;
}

/* Releases ref elements (SCR_ELEM_STR/ARR/BYTES/REF) recursively at rc == 0.
 * NULL-tolerant (uninitialized locals). Cycle-capable arrays (`cyc`) feed
 * the candidate-root buffer like every headered type. */
void scr_arr_release(ScrArr *a);
void scr_arr_copy_metadata(ScrArr *a, struct ScrDyn *target);
/* Installed by scr_regex.c when it records a pending match source; this
 * unit links without the regex runtime. Writes the pending metadata of
 * `a` into its dynamic copy or materializes it, answering whether it
 * wrote. */
extern SCR_TL bool (*scr_arr_match_copy)(ScrArr *a, struct ScrDyn *target);
/* The array's out-of-line storage, allocated (zeroed) on first use. */
ScrArrExt *scr_arr_ext(ScrArr *a);
/* Moves inline dense slots (kept in the header block of a small array) to
 * their own allocation, and the elements of an array with head room (left
 * by shift) to the start of theirs, so the storage pointers may be swapped
 * with another array's. No-op for other arrays. */
void scr_arr_outline(ScrArr *a);
/* Swaps the sparse slots and numeric properties of two arrays; each keeps
 * its own match metadata (refresh of a cached typed view, llvm/dyn.ts). */
void scr_arr_swap_indexed_ext(ScrArr *a, ScrArr *b);

/* Trace entry point for cycle-capable arrays — stored in their collector
 * header and passed wherever a container stores an ARRAY payload's RC entry
 * points and the array type is cycle-capable (boxes, union arms, map
 * values, promise payloads), exactly like scr_map_trace_v. */
void scr_arr_trace_v(void *a, ScrTraceVisit visit, void *ctx);

double scr_arr_len(ScrArr *a);
/* Shared hole/property query. Canonical indices answer from indexed storage;
 * noncanonical numeric keys answer from the ordinary-property vector. Missing
 * keys and indices >= length answer false without trapping; callers that need
 * a value must still use the proven-presence get accessors below. */
bool scr_arr_has(const ScrArr *a, double i);
double scr_arr_state(const ScrArr *a, double i);
double scr_arr_next_present(const ScrArr *a, double start);
/* Set Array.prototype.length semantics for the supported native array
 * surface. Growth creates holes without allocating a dense prefix; shrinking
 * releases removed reference elements. Invalid lengths set a catchable
 * RangeError and leave the array unchanged. */
void scr_arr_set_len(ScrArr *a, double length);
/* Copy one slot from src into dst, retaining reference elements when the
 * source slot is present. The destination must already have a length that
 * includes dst_index. Holes remain holes. */
void scr_arr_copy_index(ScrArr *dst, size_t dst_index, const ScrArr *src,
                        size_t src_index);
/* Copy a range while preserving holes. `dst_start` and `src_start` are the
 * starts of equal-length ranges; with reverse=true the source range is
 * copied in reverse order. Reference elements are retained. */
void scr_arr_copy_range(ScrArr *dst, size_t dst_start, const ScrArr *src,
                        size_t src_start, size_t count, bool reverse);
void scr_arr_copy_range_ex(ScrArr *dst, size_t dst_start, const ScrArr *src,
                           size_t src_start, size_t count, bool reverse,
                           bool materialize_holes);
/* Mutating indexed operations borrow the receiver and value, preserve
 * sparse presence, and return the receiver retained. */
ScrArr *scr_arr_copy_within(ScrArr *a, double target, double start, double end);
ScrArr *scr_arr_fill_f64(ScrArr *a, double value, double start, double end);
ScrArr *scr_arr_fill_bool(ScrArr *a, bool value, double start, double end);
ScrArr *scr_arr_fill_ref(ScrArr *a, void *value, double start, double end);
ScrArr *scr_arr_fill_undefined(ScrArr *a, double start, double end);
/* Math.max(...xs) / Math.min(...xs) over an f64-element array: the JS
 * fold (NaN poisons, ±0 by the JS preferences, empty → ∓Infinity). */
double scr_math_max_arr(ScrArr *a);
double scr_math_min_arr(ScrArr *a);
double scr_math_hypot_arr(ScrArr *a);
/* The scalar Math statics (scr_lib.c): min/max are the ECMA two-argument
 * folds (NaN poisons; max prefers +0, min prefers -0 — NOT C's fmin/fmax);
 * random is a uniform [0,1) double at 53-bit granularity from
 * arc4random_buf (SEMANTICS.md 62: Node's distribution, not its sequence). */
double scr_math_min(double a, double b);
double scr_math_round(double x);
double scr_math_pow(double base, double exponent);
double scr_math_clz32(double x);
double scr_math_fround(double x);
double scr_math_imul(double a, double b);
double scr_math_max(double a, double b);
double scr_math_random(void);

double scr_arr_get_f64(ScrArr *a, double i); /* trap missing/hole */
/* ToNumber(a[i]) for f64 storage: borrows a; missing/hole/undefined -> NaN. */
double scr_arr_get_number(const ScrArr *a, double i);
/* Strict equality of ordinary indexed reads on matching primitive arrays.
 * Borrows both arrays, preserves undefined vs NaN, and never allocates. */
bool scr_arr_index_eq(const ScrArr *a, double i, const ScrArr *b, double j);
bool scr_arr_get_bool(ScrArr *a, double i);  /* trap missing/hole */
void *scr_arr_get_ref(ScrArr *a, double i);  /* trap missing/hole; +1 */
void *scr_arr_borrow_ref(ScrArr *a, double i); /* same checks; borrowed */
/* Borrow a non-null reference element, or NULL for a hole/undefined/missing
 * property. Keep the array alive and retain before removing its element.
 * This read does not invoke retain callbacks or mutate runtime state. */
void *scr_arr_peek_ref(const ScrArr *a, double i);

/* i == len appends; the _ref variant releases the old element (when
 * replacing) and takes ownership of the new one. */
void scr_arr_set_f64(ScrArr *a, double i, double v);
void scr_arr_set_bool(ScrArr *a, double i, bool v);
void scr_arr_set_ref(ScrArr *a, double i, void *v);
void scr_arr_set_undefined(ScrArr *a, double i);
bool scr_arr_delete(ScrArr *a, double i);

/* slice(start?, end?): a fresh +1 shallow copy of the index range —
 * ToIntegerOrInfinity indices, negatives from the end, clamping; ref
 * elements retain into the copy. Borrows a. */
ScrArr *scr_arr_slice(ScrArr *a, double start, double end);

/* ES2023 copying methods. All borrow their inputs and return fresh +1
 * shallow copies. with() raises Node's catchable RangeError for an invalid
 * relative index; the ref variant retains the borrowed replacement. */
ScrArr *scr_arr_to_reversed(const ScrArr *a);
ScrArr *scr_arr_to_spliced(const ScrArr *a, double start,
                           double delete_count, const ScrArr *items);
ScrArr *scr_arr_with_f64(ScrArr *a, double index, double value);
ScrArr *scr_arr_with_bool(ScrArr *a, double index, bool value);
ScrArr *scr_arr_with_ref(ScrArr *a, double index, void *value);
ScrArr *scr_arr_with_undefined(ScrArr *a, double index);

/* push returns the new length (JS-exact); _ref takes ownership. */
double scr_arr_push_f64(ScrArr *a, double v);
double scr_arr_push_bool(ScrArr *a, bool v);
double scr_arr_push_ref(ScrArr *a, void *v);
/* Compiler-built slot buffers do not alias array storage. Both operations
 * move ownership of every slot and preserve the evaluated argument order. */
double scr_arr_push_many(ScrArr *a, size_t count, const uint64_t *slots);
double scr_arr_unshift_many(ScrArr *a, size_t count, const uint64_t *slots);
/* Append a same-element-kind array through the JS iterator contract: holes
 * become present undefined states. The source is borrowed and self-spread
 * duplicates the original indexed state. */
double scr_arr_push_spread(ScrArr *a, const ScrArr *src);
/* Append a concat argument by indexed property copy, preserving holes. */
double scr_arr_concat_copy(ScrArr *a, const ScrArr *src);

/* unshift returns the new length and _ref takes ownership. The spread form
 * borrows a same-element-kind source, retains copied refs, and snapshots
 * self-spread. reverse mutates in place and returns the receiver at +1. */
double scr_arr_unshift_f64(ScrArr *a, double v);
double scr_arr_unshift_bool(ScrArr *a, bool v);
double scr_arr_unshift_ref(ScrArr *a, void *v);
double scr_arr_unshift_spread(ScrArr *a, const ScrArr *src);
ScrArr *scr_arr_reverse(ScrArr *a);
/* Default primitive String ordering; stable, borrowed receiver, owned result. */
ScrArr *scr_arr_sort_primitive(ScrArr *a, bool copy);
/* Stable comparator sort of the first `count` slots of a private, compacted
 * snapshot (every slot a value; f64 or reference elements). `f` is a borrowed
 * closure of `arity` (0..2) element parameters returning a number. Elements
 * move without reference-count traffic; a pending exception from `f` stops
 * the sort and leaves the snapshot unchanged. */
struct ScrClosure;
/* A nonzero `order` says `f` orders number keys ascending (1) or descending
 * (-1) without side effects: f64 elements are their own keys, and reference
 * elements read theirs through the borrowed `key` closure (element ->
 * number). Keys that are all numbers other than NaN and -0 then sort without
 * calling `f`, with the same stable result. An `order` from 2 says `f`
 * orders reference elements by several such keys, the first deciding: the
 * low byte is the key count (2..8), each bit from bit 8 marks a key that
 * orders descending, and `key` reads key j of an element (element, j ->
 * number). */
void scr_arr_sort_values(ScrArr *a, double count, struct ScrClosure *f, uint32_t arity,
                         int32_t order, struct ScrClosure *key);
/* Comparator sort of a dense array in place: `a.sort(f)`, or with `owned`
 * the private copy of `a.toSorted(f)`. Returns false without calling `f`
 * when `a` has holes, storage-level undefined or a sparse tail, or is
 * published; the caller then sorts a compacted snapshot. Otherwise sorts
 * and returns true; a pending exception from `f` leaves a shared `a`
 * unwritten (an owned copy then holds a permutation of its values). */
/* The borrowed 8-byte slots of `a` when every index below its length holds
 * a value in dense storage (length in *len); NULL for holes, storage-level
 * undefined, sparse tails, empty arrays and boolean elements. */
const uint64_t *scr_arr_dense_slots(const ScrArr *a, size_t *len);
bool scr_arr_sort_dense(ScrArr *a, struct ScrClosure *f, uint32_t arity, bool owned,
                        int32_t order, struct ScrClosure *key);
/* V8's TimSort over n slots with a caller comparison: less(ctx, x, y)
 * answers whether x orders before y (comparefn(x, y) < 0), or sets *failed,
 * with an exception pending, to stop the sort. Returns false after a
 * failure; `values` is then unchanged, and it holds every slot exactly once,
 * in its original order, whenever `less` runs. */
typedef bool (*ScrSortLess)(void *ctx, uint64_t x, uint64_t y, bool *failed);
bool scr_sort_slots_with(uint64_t *values, size_t n, ScrSortLess less, void *ctx);

/* pop traps on an empty array; _ref transfers ownership out (+1 to the
 * caller, no release). */
double scr_arr_pop_f64(ScrArr *a);
bool scr_arr_pop_bool(ScrArr *a);
void *scr_arr_pop_ref(ScrArr *a);
uint8_t scr_arr_pop_state(ScrArr *a, uint64_t *slot_out);

/* shift: the first element out; the rest stay in place behind head room
 * (amortized O(1)). The emitter guards the empty array (JS's undefined —
 * the `elem | undefined` union), so empty here is an internal error; _ref
 * transfers ownership out like pop. */
double scr_arr_shift_f64(ScrArr *a);
bool scr_arr_shift_bool(ScrArr *a);
void *scr_arr_shift_ref(ScrArr *a);
uint8_t scr_arr_shift_state(ScrArr *a, uint64_t *slot_out);

/* splice(start, deleteCount) — the REMOVAL forms: Node-exact
 * relative/clamped start, count clamped to [0, len - start] (+Infinity =
 * to the end). Returns the removed elements in order as a fresh +1 array,
 * ownership MOVED out of the receiver. Borrows a. */
ScrArr *scr_arr_splice(ScrArr *a, double start, double deleteCount);
ScrArr *scr_arr_splice_insert(ScrArr *a, double start, double deleteCount,
                              const ScrArr *items);
/* The same splice in statement position: inserts `count` owned value slots
 * (moved in) and releases the removed elements without building a result
 * array. Borrows a. */
void scr_arr_splice_drop(ScrArr *a, double start, double deleteCount, size_t count,
                         const uint64_t *slots);
ScrArr *scr_arr_flat_copy(const ScrArr *a, ScrArr *out, bool flatten);

/* indexOf: first index whose element strictly equals (JS ===) the needle,
 * or -1. Per element kind: f64 by value (NaN never matches — NaN !== NaN;
 * -0 matches 0), bool by value, SCR_ELEM_STR by CONTENT (JS strings are
 * primitives), SCR_ELEM_ARR/SCR_ELEM_REF by reference identity (JS object
 * equality; the compiler fences union-element arrays, whose boxes are
 * compiler artifacts pointer identity would misjudge). The _ref variants
 * BORROW the needle (no ownership change). */
double scr_arr_index_of_f64(ScrArr *a, double v);
double scr_arr_index_of_bool(ScrArr *a, bool v);
double scr_arr_index_of_ref(ScrArr *a, void *v);

/* includes: SameValueZero — exactly indexOf's equality EXCEPT NaN matches
 * NaN (JS: [NaN].indexOf(NaN) === -1 but [NaN].includes(NaN) === true). */
bool scr_arr_includes_f64(ScrArr *a, double v);
bool scr_arr_includes_bool(ScrArr *a, bool v);
bool scr_arr_includes_ref(ScrArr *a, void *v);

/* join(sep): elements stringified exactly like JS String(x) — numbers via
 * scr_f64_to_str (shortest roundtrip), booleans "true"/"false", strings
 * verbatim — with sep between. f64/bool/str element kinds only (the
 * compiler rejects the rest). Borrows both args; returns +1. */
ScrStr *scr_arr_join(ScrArr *a, ScrStr *sep);
/* String.raw over the raw literals and pre-stringified substitutions
 * (both SCR_ELEM_STR): the spec's interleave — extra substitutions drop,
 * missing ones skip. Borrows both; +1 result; never throws. */
ScrStr *scr_str_raw(ScrArr *raw, ScrArr *subs);

#endif /* SCR_ARRAY_H */
