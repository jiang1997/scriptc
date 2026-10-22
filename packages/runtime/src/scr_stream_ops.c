/* node:stream's Readable operators (lib/internal/streams/operators.js):
 * map, filter, forEach, toArray, some, find, every, flatMap, drop, take
 * and reduce, over streams whose chunks are strings or Buffers. Linked
 * only when a program calls one (the streamOps feature).
 *
 * Node writes the operators as async functions and async generators, and
 * wraps the stream-returning ones in Readable.from. Their observable
 * ordering (when callbacks run relative to the consumer, when promises
 * settle) is the order of those functions' awaits, so this unit follows
 * the JavaScript source step for step: every `await x` is one op_await
 * (a promise job after x settles, the same hop a compiled await takes),
 * the generators follow the async generator protocol (request queue,
 * yield awaiting its operand, return and throw requests), and the
 * Readable.from(generator) wrapper is from.js's nextAsync/close. Each
 * step runs on its own fiber through scr_async_spawn_after, so the unit
 * works on every target, wasm32 included.
 *
 * The user's callbacks are checked-dynamic function values called with
 * one argument (the chunk); callbacks that declare the options argument
 * ({ signal }) are refused, because the AbortSignal Node passes there has
 * no representation here. options.signal itself is polled where Node
 * polls it (signal.aborted), so no listener is needed. Stream-returning
 * operators produce object-mode Readables whose entries are strings or
 * Buffers; any other value is refused when it would be pushed. */
#include "scr_runtime.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void op_oom(void) {
  fputs("scriptc: out of memory\n", stderr);
  abort();
}

static void *op_alloc(size_t n) {
  void *p = calloc(1, n);
  if (!p) op_oom();
  return p;
}

/* ── refcounted step owners ────────────────────────────────────────── */

typedef struct OpObj OpObj;
struct OpObj {
  size_t rc;
  void (*drop)(OpObj *self); /* frees the object's own fields and itself */
};

static void *op_ref(void *o) {
  ((OpObj *)o)->rc++;
  return o;
}

static void op_unref(void *o) {
  OpObj *b = o;
  if (--b->rc == 0) b->drop(b);
}

/* ── sentinels ─────────────────────────────────────────────────────── */

/* kEmpty (a callback result that yields nothing), kEof (the pump's end
 * marker) and the generators' done marker: process-lived objects
 * compared by identity, never visible to the program. */
static SCR_TL ScrDyn *op_k_empty = NULL;
static SCR_TL ScrDyn *op_k_eof = NULL;
static SCR_TL ScrDyn *op_k_done = NULL;

static void op_sentinels_free(void) {
  scr_dyn_release(op_k_empty);
  scr_dyn_release(op_k_eof);
  scr_dyn_release(op_k_done);
  op_k_empty = op_k_eof = op_k_done = NULL;
}

static void op_sentinels_init(void) {
  if (op_k_empty) return;
  op_k_empty = scr_dyn_new_obj();
  op_k_eof = scr_dyn_new_obj();
  op_k_done = scr_stream_from_done(); /* shared with pumpToNode (scr_stream.c) */
  scr_atexit(op_sentinels_free);
}

/* ── awaits ────────────────────────────────────────────────────────── */

/* A continuation receives the awaited value (+1), or NULL with the
 * rejection pending in the exception cell. It must leave no exception
 * pending when it returns. */
typedef void (*OpCont)(void *self, ScrDyn *value);

typedef struct {
  void *self;
  OpCont k;
  ScrPromise *p;
} OpAwait;

static void op_await_entry(ScrFiber *fiber, void *arg) {
  (void)fiber;
  OpAwait a = *(OpAwait *)arg;
  free(arg);
  ScrDyn *v = scr_await_dyn(a.p);
  scr_promise_release(a.p);
  a.k(a.self, v);
  if (scr_exc_pending()) scr_exc_clear();
  op_unref(a.self);
}

/* `await p`: k runs in the promise job after p settles. Borrows p. */
static void op_await(ScrPromise *p, OpCont k, void *self) {
  OpAwait *a = op_alloc(sizeof *a);
  a->self = op_ref(self);
  a->k = k;
  a->p = scr_promise_retain(p);
  ScrPromise *fiber = scr_async_spawn_after(p, &op_await_entry, a);
  scr_promise_release(fiber);
}

static ScrPromise *op_resolved(ScrDyn *v /*borrowed*/) {
  ScrPromise *p = scr_promise_new();
  scr_promise_fulfill_ref(p, scr_dyn_retain(v), scr_dyn_retain_v, scr_dyn_release_v, NULL);
  return p;
}

/* `await v` over a value: a promise is awaited, anything else is awaited
 * as an already resolved promise (one job). Borrows v. */
static void op_await_value(ScrDyn *v, OpCont k, void *self) {
  if (v->kind == SCR_DYN_PROMISE) {
    op_await(v->v.promise, k, self);
    return;
  }
  ScrPromise *p = op_resolved(v);
  op_await(p, k, self);
  scr_promise_release(p);
}

static void op_fulfill(ScrPromise *p, ScrDyn *v /*borrowed*/) {
  scr_promise_fulfill_ref(p, scr_dyn_retain(v), scr_dyn_retain_v, scr_dyn_release_v, NULL);
}

/* Rejects p with a saved exception (borrowed). */
static void op_reject(ScrPromise *p, const ScrCaught *c) {
  scr_rethrow(c);
  scr_promise_reject_pending(p);
}

/* PromiseReject(err) for a saved exception: +1 dyn promise. */
static ScrDyn *op_rejected_dyn(const ScrCaught *c) {
  ScrPromise *p = scr_promise_new();
  op_reject(p, c);
  ScrDyn *d = scr_dyn_new_promise(p);
  scr_promise_release(p);
  return d;
}

/* ── errors ────────────────────────────────────────────────────────── */

static ScrCaught *op_take_error(ScrError *e /*moves*/) {
  scr_throw_obj(e, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
  return scr_exc_take();
}

/* new AbortError() or new AbortError(undefined, { cause }) */
static ScrError *op_abort_error(const ScrDyn *cause /*NULL: no cause*/) {
  ScrStr *message = scr_str_new("The operation was aborted", 25);
  ScrError *e = scr_error_new(SCR_ERR_ERROR, message);
  scr_str_release(message);
  scr_str_release(e->name);
  e->name = scr_str_new("AbortError", 10);
  /* AbortError assigns code, then name: own enumerable properties */
  scr_error_set_code(e, "ABORT_ERR");
  e->name_present = true;
  e->name_enumerable = true;
  if (cause) scr_error_define_cause(e, (ScrDyn *)cause);
  return e;
}

static ScrError *op_coded_error(int kind, const char *code, const char *message) {
  ScrStr *m = scr_str_new(message, strlen(message));
  ScrError *e = scr_error_new(kind, m);
  scr_str_release(m);
  scr_error_set_code(e, code);
  return e;
}

/* ERR_OUT_OF_RANGE: `The value of "<name>" is out of range. It must be
 * <range>. Received <n>` (thrown; pending on return). */
static void op_throw_out_of_range(const char *name, const char *range, double received) {
  char num[48];
  scr_num_received(received, num);
  char msg[256];
  int n = snprintf(msg, sizeof msg, "The value of \"%s\" is out of range. It must be %s. Received %s",
                   name, range, num);
  scr_throw_error_msg_code(SCR_ERR_RANGE, msg, (size_t)n, "ERR_OUT_OF_RANGE");
}

/* The runtime refusal for a value outside the string/Buffer model. */
static ScrError *op_unsupported(const char *what) {
  char msg[256];
  int n = snprintf(msg, sizeof msg, "%s is not supported yet", what);
  ScrStr *m = scr_str_new(msg, (size_t)n);
  ScrError *e = scr_error_new(SCR_ERR_ERROR, m);
  scr_str_release(m);
  return e;
}

/* ── options ───────────────────────────────────────────────────────── */

static ScrDyn *op_get(const ScrDyn *obj, const char *key) {
  if (!obj) return NULL;
  size_t n = strlen(key);
  if (obj->kind == SCR_DYN_OBJ) {
    ScrDyn *v = scr_dyn_obj_get(obj, key, n);
    return v ? scr_dyn_retain(v) : NULL;
  }
  if (obj->kind == SCR_DYN_HANDLE) {
    ScrStr *k = scr_str_new(key, n);
    ScrDyn *v = scr_dyn_handle_key_get(obj, k);
    scr_str_release(k);
    return v;
  }
  return NULL;
}

static bool op_nullish(const ScrDyn *v) {
  return v == NULL || v->kind == SCR_DYN_UNDEF || v->kind == SCR_DYN_NULL;
}

/* validateObject(options, 'options') when options != null: false with
 * ERR_INVALID_ARG_TYPE pending. */
static bool op_check_options(const ScrDyn *options) {
  if (op_nullish(options)) return true;
  if ((options->kind == SCR_DYN_OBJ || options->kind == SCR_DYN_HANDLE) &&
      !scr_dyn_is_callable(options)) {
    return true;
  }
  scr_dyn_arg_type_fail("options", "of type object", options);
  return false;
}

/* options.signal when != null, validated (validateAbortSignal): +1, or
 * NULL when absent. *ok false with ERR_INVALID_ARG_TYPE pending. */
static ScrDyn *op_signal(const ScrDyn *options, bool *ok) {
  *ok = true;
  ScrDyn *s = op_get(options, "signal");
  if (op_nullish(s)) {
    if (s) scr_dyn_release(s);
    return NULL;
  }
  ScrDyn *aborted = NULL;
  if (s->kind == SCR_DYN_OBJ || s->kind == SCR_DYN_HANDLE) aborted = op_get(s, "aborted");
  if (!aborted) {
    scr_dyn_prop_type_fail("options.signal", "an instance of AbortSignal", s);
    scr_dyn_release(s);
    *ok = false;
    return NULL;
  }
  scr_dyn_release(aborted);
  return s;
}

static bool op_aborted(const ScrDyn *signal) {
  if (!signal) return false;
  ScrDyn *a = op_get(signal, "aborted");
  bool r = a && scr_dyn_truthy(a);
  if (a) scr_dyn_release(a);
  return r;
}

/* The callback argument: a function that does not read the options
 * argument. `max` is how many parameters Node's call passes before the
 * options. False with the error pending. */
static bool op_check_fn(const ScrDyn *fn, const char *name, uint32_t max) {
  if (!fn || !scr_dyn_is_callable(fn)) {
    scr_dyn_arg_type_fail(name, "of type function", fn ? fn : scr_dyn_undefined());
    return false;
  }
  if (fn->kind == SCR_DYN_FUNC && fn->v.fn.arity > max) {
    static const char m[] =
        "stream operator callbacks that read the options argument ({ signal }) are not supported yet";
    scr_throw_error_msg(SCR_ERR_ERROR, m, sizeof m - 1);
    return false;
  }
  return true;
}

/* ── iteration sources ─────────────────────────────────────────────── */

typedef struct OpGen OpGen;

/* `for await (const v of src)` over a Readable (its async iterator) or an
 * operator generator. */
typedef struct {
  ScrStream *s; /* +1, or NULL */
  OpGen *g;     /* +1, or NULL */
} OpSrc;

static ScrPromise *gen_next(OpGen *g);
static ScrPromise *gen_return(OpGen *g, ScrDyn *v);
static ScrPromise *gen_throw(OpGen *g, const ScrCaught *c);

/* iterator.next(): +1 promise of the next value or the end. */
static ScrPromise *src_next(OpSrc *src) {
  return src->s ? scr_stream_next_chunk_dyn(src->s) : gen_next(src->g);
}

static bool src_done(const OpSrc *src, const ScrDyn *v) {
  return src->s ? scr_stream_chunk_done(v) : v == op_k_done;
}

/* The Readable iterator's return(): the iterator generator resumes at its
 * yield with a return completion (one await), its finally destroys the
 * stream (destroyer: an AbortError when not finished), and the request
 * settles. */
typedef struct {
  OpObj base;
  ScrStream *s;
  ScrPromise *p;
} OpStreamReturn;

static void op_stream_return_drop(OpObj *o) {
  OpStreamReturn *r = (OpStreamReturn *)o;
  scr_stream_release(r->s);
  scr_promise_release(r->p);
  free(r);
}

static void op_stream_return_k(void *self, ScrDyn *v) {
  OpStreamReturn *r = self;
  if (v) scr_dyn_release(v);
  scr_stream_release(scr_stream_iterator_close(r->s));
  op_fulfill(r->p, op_k_done);
}

static ScrPromise *src_return(OpSrc *src) {
  if (src->g) return gen_return(src->g, scr_dyn_undefined());
  OpStreamReturn *r = op_alloc(sizeof *r);
  r->base.rc = 1;
  r->base.drop = &op_stream_return_drop;
  r->s = scr_stream_retain(src->s);
  r->p = scr_promise_new();
  ScrPromise *result = scr_promise_retain(r->p);
  op_await_value(scr_dyn_undefined(), &op_stream_return_k, r);
  op_unref(r);
  return result;
}

static void src_release(OpSrc *src) {
  if (src->s) scr_stream_release(src->s);
  if (src->g) op_unref(src->g);
  src->s = NULL;
  src->g = NULL;
}

/* ── the async generator protocol ──────────────────────────────────── */

enum { GS_START, GS_SUSPENDED, GS_EXECUTING, GS_AWAIT_RETURN, GS_DONE };
enum { GR_NEXT, GR_RETURN, GR_THROW };

typedef struct {
  ScrPromise *p;
  int kind;
  ScrDyn *value;    /* return value (+1) */
  ScrCaught *error; /* throw value (+1) */
} OpGenReq;

/* An operator generator: the protocol state plus the body's entry points.
 * resume runs the body from its start or from the yield it is suspended
 * at (normal completion); ret delivers a return completion at that yield
 * (after the unwrap await) and thr a throw completion. */
struct OpGen {
  OpObj base;
  int state;
  OpGenReq *q;
  size_t qh, qn, qcap;
  void (*resume)(OpGen *g);
  void (*ret)(OpGen *g, ScrDyn *v);
  void (*thr)(OpGen *g, ScrCaught *c);
  void (*body_drop)(OpGen *g);
};

static void gen_drop(OpObj *o) {
  OpGen *g = (OpGen *)o;
  for (size_t i = g->qh; i < g->qn; i++) {
    scr_promise_release(g->q[i].p);
    if (g->q[i].value) scr_dyn_release(g->q[i].value);
    if (g->q[i].error) scr_caught_release(g->q[i].error);
  }
  free(g->q);
  g->body_drop(g);
}

static ScrPromise *gen_enqueue(OpGen *g, int kind, ScrDyn *value, const ScrCaught *error) {
  if (g->qn == g->qcap) {
    if (g->qh > 0) {
      memmove(g->q, g->q + g->qh, (g->qn - g->qh) * sizeof *g->q);
      g->qn -= g->qh;
      g->qh = 0;
    }
    if (g->qn == g->qcap) {
      g->qcap = g->qcap ? g->qcap * 2 : 4;
      g->q = realloc(g->q, g->qcap * sizeof *g->q);
      if (!g->q) op_oom();
    }
  }
  OpGenReq *r = &g->q[g->qn++];
  r->p = scr_promise_new();
  r->kind = kind;
  r->value = value ? scr_dyn_retain(value) : NULL;
  r->error = error ? scr_caught_retain((ScrCaught *)error) : NULL;
  return scr_promise_retain(r->p);
}

static bool gen_has_req(const OpGen *g) { return g->qh < g->qn; }

static OpGenReq gen_shift(OpGen *g) {
  OpGenReq r = g->q[g->qh++];
  if (g->qh == g->qn) g->qh = g->qn = 0;
  return r;
}

static void gen_req_release(OpGenReq *r) {
  scr_promise_release(r->p);
  if (r->value) scr_dyn_release(r->value);
  if (r->error) scr_caught_release(r->error);
}

static void gen_drain(OpGen *g);

/* AsyncGeneratorAwaitReturn: await the value, then the request settles
 * done (a rejection rejects it). */
typedef struct {
  OpObj base;
  OpGen *g;
  ScrPromise *p;
} OpAwaitReturn;

static void op_await_return_drop(OpObj *o) {
  OpAwaitReturn *a = (OpAwaitReturn *)o;
  op_unref(a->g);
  scr_promise_release(a->p);
  free(a);
}

static void op_await_return_k(void *self, ScrDyn *v) {
  OpAwaitReturn *a = self;
  OpGen *g = a->g;
  if (v) {
    scr_dyn_release(v);
    op_fulfill(a->p, op_k_done);
  } else {
    scr_promise_reject_pending(a->p);
  }
  g->state = GS_DONE;
  gen_drain(g);
}

static void gen_await_return(OpGen *g, OpGenReq *r) {
  g->state = GS_AWAIT_RETURN;
  OpAwaitReturn *a = op_alloc(sizeof *a);
  a->base.rc = 1;
  a->base.drop = &op_await_return_drop;
  a->g = op_ref(g);
  a->p = scr_promise_retain(r->p);
  op_await_value(r->value ? r->value : scr_dyn_undefined(), &op_await_return_k, a);
  op_unref(a);
}

/* The completed generator answers its queued requests: next settles done
 * at once, throw rejects at once, return awaits its value first. */
static void gen_drain(OpGen *g) {
  while (g->state == GS_DONE && gen_has_req(g)) {
    OpGenReq r = gen_shift(g);
    if (r.kind == GR_RETURN) {
      gen_await_return(g, &r);
      gen_req_release(&r);
      return;
    }
    if (r.kind == GR_THROW) {
      op_reject(r.p, r.error);
    } else {
      op_fulfill(r.p, op_k_done);
    }
    gen_req_release(&r);
  }
}

/* The body finished: the first request settles (done, or rejected with
 * the body's exception), then the queue drains. Borrows c. */
static void gen_complete(OpGen *g, const ScrCaught *c) {
  g->state = GS_DONE;
  if (gen_has_req(g)) {
    OpGenReq r = gen_shift(g);
    if (c) op_reject(r.p, c);
    else op_fulfill(r.p, op_k_done);
    gen_req_release(&r);
  }
  gen_drain(g);
}

/* Delivers the first queued request to a body suspended at a yield (or
 * already running its continuation): next resumes it, return awaits the
 * value and then delivers the return completion, throw delivers the
 * throw completion. */
typedef struct {
  OpObj base;
  OpGen *g;
} OpUnwrapReturn;

static void op_unwrap_return_drop(OpObj *o) {
  OpUnwrapReturn *u = (OpUnwrapReturn *)o;
  op_unref(u->g);
  free(u);
}

static void op_unwrap_return_k(void *self, ScrDyn *v) {
  OpGen *g = ((OpUnwrapReturn *)self)->g;
  if (!v) {
    ScrCaught *c = scr_exc_take();
    g->thr(g, c);
    scr_caught_release(c);
    return;
  }
  g->ret(g, v);
  scr_dyn_release(v);
}

static void gen_deliver(OpGen *g) {
  OpGenReq *r = &g->q[g->qh];
  g->state = GS_EXECUTING;
  if (r->kind == GR_NEXT) {
    g->resume(g);
  } else if (r->kind == GR_THROW) {
    g->thr(g, r->error);
  } else {
    OpUnwrapReturn *u = op_alloc(sizeof *u);
    u->base.rc = 1;
    u->base.drop = &op_unwrap_return_drop;
    u->g = op_ref(g);
    op_await_value(r->value ? r->value : scr_dyn_undefined(), &op_unwrap_return_k, u);
    op_unref(u);
  }
}

static ScrPromise *gen_request(OpGen *g, int kind, ScrDyn *value, const ScrCaught *error) {
  ScrPromise *p = gen_enqueue(g, kind, value, error);
  if (g->state == GS_START) {
    if (kind == GR_NEXT) {
      gen_deliver(g);
    } else {
      /* A generator that never started completes without running. */
      g->state = GS_DONE;
      gen_drain(g);
    }
  } else if (g->state == GS_SUSPENDED) {
    gen_deliver(g);
  } else if (g->state == GS_DONE) {
    gen_drain(g);
  }
  return p;
}

static ScrPromise *gen_next(OpGen *g) { return gen_request(g, GR_NEXT, NULL, NULL); }
static ScrPromise *gen_return(OpGen *g, ScrDyn *v) { return gen_request(g, GR_RETURN, v, NULL); }
static ScrPromise *gen_throw(OpGen *g, const ScrCaught *c) { return gen_request(g, GR_THROW, NULL, c); }

/* The body yields an awaited value: the request settles with it, and the
 * body continues at once when another request is queued (the generator
 * never suspends), or suspends until the next one. Borrows v. */
static void gen_yield_now(OpGen *g, ScrDyn *v) {
  OpGenReq r = gen_shift(g);
  op_fulfill(r.p, v);
  gen_req_release(&r);
  if (gen_has_req(g)) {
    gen_deliver(g);
  } else {
    g->state = GS_SUSPENDED;
  }
}

/* `yield v` in an async generator awaits v first. */
static void op_yield_k(void *self, ScrDyn *v) {
  OpGen *g = self;
  if (!v) {
    ScrCaught *c = scr_exc_take();
    g->thr(g, c);
    scr_caught_release(c);
    return;
  }
  gen_yield_now(g, v);
  scr_dyn_release(v);
}

static void gen_yield(OpGen *g, ScrDyn *v /*borrowed*/) { op_await_value(v, &op_yield_k, g); }

static void gen_init(OpGen *g, void (*body_drop)(OpGen *)) {
  g->base.rc = 1;
  g->base.drop = &gen_drop;
  g->state = GS_START;
  g->body_drop = body_drop;
}

/* ── map (and filter, forEach, every through it) ───────────────────── */

/* How each source value turns into the queued result: map calls fn
 * directly; filter, forEach and every go through Node's async wrappers
 * (filterFn, forEachFn, and every's negating predicate inside filterFn). */
enum { MODE_MAP, MODE_FILTER, MODE_FOREACH, MODE_EVERY };

typedef struct {
  OpGen g;
  OpSrc src;
  ScrDyn *fn;     /* +1 */
  ScrDyn *signal; /* +1 or NULL */
  int mode;
  double concurrency, hwm;
  ScrDyn **queue; /* +1 entries: dyn promises or kEof */
  size_t qh, qn, qcap;
  double cnt;
  bool done;
  ScrPromise *next_p;   /* the consumer's `await new Promise(r => next = r)` */
  ScrPromise *resume_p; /* the pump's `await new Promise(r => resume = r)` */
  bool started;
} OpMap;

static void op_map_body_drop(OpGen *g) {
  OpMap *m = (OpMap *)g;
  src_release(&m->src);
  scr_dyn_release(m->fn);
  if (m->signal) scr_dyn_release(m->signal);
  for (size_t i = m->qh; i < m->qn; i++) scr_dyn_release(m->queue[i]);
  free(m->queue);
  if (m->next_p) scr_promise_release(m->next_p);
  if (m->resume_p) scr_promise_release(m->resume_p);
  free(m);
}

static void map_push(OpMap *m, ScrDyn *v /*moves*/) {
  if (m->qn == m->qcap) {
    if (m->qh > 0) {
      memmove(m->queue, m->queue + m->qh, (m->qn - m->qh) * sizeof *m->queue);
      m->qn -= m->qh;
      m->qh = 0;
    }
    if (m->qn == m->qcap) {
      m->qcap = m->qcap ? m->qcap * 2 : 4;
      m->queue = realloc(m->queue, m->qcap * sizeof *m->queue);
      if (!m->queue) op_oom();
    }
  }
  m->queue[m->qn++] = v;
}

static size_t map_qlen(const OpMap *m) { return m->qn - m->qh; }

/* resolve() of the pending resume/next promise */
static void map_wake(ScrPromise **slot) {
  if (!*slot) return;
  ScrPromise *p = *slot;
  *slot = NULL;
  op_fulfill(p, scr_dyn_undefined());
  scr_promise_release(p);
}

static void map_maybe_resume(OpMap *m) {
  if (m->resume_p && !m->done && m->cnt < m->concurrency && (double)map_qlen(m) < m->hwm) {
    map_wake(&m->resume_p);
  }
}

static void map_after_item(OpMap *m) {
  m->cnt -= 1;
  map_maybe_resume(m);
}

/* PromisePrototypeThen(val, afterItemProcessed, onCatch) */
static void map_item_settled_k(void *self, ScrDyn *v) {
  OpMap *m = self;
  if (v) {
    scr_dyn_release(v);
  } else {
    scr_exc_clear();
    m->done = true;
  }
  map_after_item(m);
}

/* ── the async wrappers around the user's callback ── */

/* An async function's promise settled from an awaited inner value. */
typedef struct {
  OpObj base;
  ScrPromise *p;   /* the wrapper's promise */
  ScrDyn *chunk;   /* the source value (filter returns it) */
  int mode;
  int stage;       /* MODE_EVERY: 0 the negating arrow, 1 filterFn */
} OpWrap;

static void op_wrap_drop(OpObj *o) {
  OpWrap *w = (OpWrap *)o;
  scr_promise_release(w->p);
  if (w->chunk) scr_dyn_release(w->chunk);
  free(w);
}

static OpWrap *op_wrap_new(int mode, ScrDyn *chunk, int stage) {
  OpWrap *w = op_alloc(sizeof *w);
  w->base.rc = 1;
  w->base.drop = &op_wrap_drop;
  w->p = scr_promise_new();
  w->chunk = chunk ? scr_dyn_retain(chunk) : NULL;
  w->mode = mode;
  w->stage = stage;
  return w;
}

static void op_wrap_k(void *self, ScrDyn *v) {
  OpWrap *w = self;
  if (!v) {
    scr_promise_reject_pending(w->p);
    return;
  }
  ScrDyn *out;
  if (w->mode == MODE_FOREACH) {
    out = scr_dyn_retain(op_k_empty);
  } else if (w->mode == MODE_EVERY && w->stage == 0) {
    out = scr_dyn_new_bool(!scr_dyn_truthy(v));
  } else {
    out = scr_dyn_retain(scr_dyn_truthy(v) ? w->chunk : op_k_empty);
  }
  scr_dyn_release(v);
  op_fulfill(w->p, out);
  scr_dyn_release(out);
}

/* Calls fn(chunk): +1 result, or NULL with the exception pending. */
static ScrDyn *op_call(ScrDyn *fn, ScrDyn *chunk) {
  ScrDyn *args[1] = {chunk};
  return scr_dyn_call(fn, args, 1, "fn");
}

/* An async wrapper body: `await fn(chunk)` then its transform. The
 * wrapper's promise rejects at once when fn throws synchronously. +1. */
static ScrPromise *op_wrap_call(OpMap *m, ScrDyn *chunk, int mode, int stage) {
  OpWrap *w = op_wrap_new(mode, chunk, stage);
  ScrPromise *result = scr_promise_retain(w->p);
  ScrDyn *r = op_call(m->fn, chunk);
  if (!r) {
    scr_promise_reject_pending(w->p);
  } else {
    op_await_value(r, &op_wrap_k, w);
    scr_dyn_release(r);
  }
  op_unref(w);
  return result;
}

/* every's filterFn: `await predicate(value)` where predicate is the
 * negating async arrow, then filterFn's own test. */
static ScrPromise *op_every_call(OpMap *m, ScrDyn *chunk) {
  ScrPromise *inner = op_wrap_call(m, chunk, MODE_EVERY, 0);
  OpWrap *w = op_wrap_new(MODE_EVERY, chunk, 1);
  ScrPromise *result = scr_promise_retain(w->p);
  op_await(inner, &op_wrap_k, w);
  scr_promise_release(inner);
  op_unref(w);
  return result;
}

/* val = fn(val, signalOpt), then PromiseResolve(val) — or
 * PromiseReject(err) when the call throws. +1 dyn promise. */
static ScrDyn *map_item(OpMap *m, ScrDyn *chunk) {
  ScrPromise *p;
  if (m->mode == MODE_MAP) {
    ScrDyn *r = op_call(m->fn, chunk);
    if (!r) {
      ScrCaught *c = scr_exc_take();
      ScrDyn *d = op_rejected_dyn(c);
      scr_caught_release(c);
      return d;
    }
    if (r->kind == SCR_DYN_PROMISE) return r;
    p = op_resolved(r);
    scr_dyn_release(r);
  } else if (m->mode == MODE_EVERY) {
    p = op_every_call(m, chunk);
  } else {
    p = op_wrap_call(m, chunk, m->mode, 0);
  }
  ScrDyn *d = scr_dyn_new_promise(p);
  scr_promise_release(p);
  return d;
}

/* ── the pump: `for await (let val of stream)` filling the queue ── */

static void map_pump_next(OpMap *m);

static void map_pump_finally(OpMap *m) {
  m->done = true;
  map_wake(&m->next_p);
}

/* catch (err): a rejected entry the consumer will throw. Borrows c. */
static void map_pump_catch(OpMap *m, const ScrCaught *c) {
  ScrDyn *val = op_rejected_dyn(c);
  op_await_value(val, &map_item_settled_k, m);
  map_push(m, val);
  map_pump_finally(m);
}

/* After the loop's AsyncIteratorClose: a return (`if (done) return`) or
 * the AbortError thrown in the body. */
typedef struct {
  OpObj base;
  OpMap *m;
  ScrCaught *thrown; /* +1, or NULL for the return */
} OpPumpClose;

static void op_pump_close_drop(OpObj *o) {
  OpPumpClose *c = (OpPumpClose *)o;
  op_unref(c->m);
  if (c->thrown) scr_caught_release(c->thrown);
  free(c);
}

static void op_pump_close_k(void *self, ScrDyn *v) {
  OpPumpClose *c = self;
  if (v) scr_dyn_release(v);
  else scr_exc_clear(); /* a throw completion keeps the original error */
  if (c->thrown) map_pump_catch(c->m, c->thrown);
  else map_pump_finally(c->m);
}

static void map_pump_close(OpMap *m, ScrCaught *thrown /*moves or NULL*/) {
  OpPumpClose *c = op_alloc(sizeof *c);
  c->base.rc = 1;
  c->base.drop = &op_pump_close_drop;
  c->m = op_ref(m);
  c->thrown = thrown;
  ScrPromise *p = src_return(&m->src);
  op_await(p, &op_pump_close_k, c);
  scr_promise_release(p);
  op_unref(c);
}

static void map_pump_resumed_k(void *self, ScrDyn *v) {
  if (v) scr_dyn_release(v);
  map_pump_next(self);
}

static void map_pump_val_k(void *self, ScrDyn *v) {
  OpMap *m = self;
  if (!v) {
    ScrCaught *c = scr_exc_take();
    map_pump_catch(m, c);
    scr_caught_release(c);
    return;
  }
  if (src_done(&m->src, v)) {
    scr_dyn_release(v);
    map_push(m, scr_dyn_retain(op_k_eof));
    map_pump_finally(m);
    return;
  }
  if (m->done) {
    scr_dyn_release(v);
    map_pump_close(m, NULL);
    return;
  }
  if (op_aborted(m->signal)) {
    scr_dyn_release(v);
    map_pump_close(m, op_take_error(op_abort_error(NULL)));
    return;
  }
  ScrDyn *val = map_item(m, v);
  scr_dyn_release(v);
  m->cnt += 1;
  op_await_value(val, &map_item_settled_k, m);
  map_push(m, val);
  map_wake(&m->next_p);
  if (!m->done && ((double)map_qlen(m) >= m->hwm || m->cnt >= m->concurrency)) {
    m->resume_p = scr_promise_new();
    op_await(m->resume_p, &map_pump_resumed_k, m);
    return;
  }
  map_pump_next(m);
}

static void map_pump_next(OpMap *m) {
  ScrPromise *p = src_next(&m->src);
  op_await(p, &map_pump_val_k, m);
  scr_promise_release(p);
}

/* ── the generator body: awaiting queue[0] and yielding ── */

static void map_consume(OpMap *m);

/* finally { done = true; if (resume) { resume(); resume = null; } } */
static void map_finally(OpMap *m) {
  m->done = true;
  map_wake(&m->resume_p);
}

static void map_cons_next_k(void *self, ScrDyn *v) {
  if (v) scr_dyn_release(v);
  map_consume(self);
}

static void map_cons_val_k(void *self, ScrDyn *v) {
  OpMap *m = self;
  OpGen *g = &m->g;
  if (!v) {
    ScrCaught *c = scr_exc_take();
    map_finally(m);
    gen_complete(g, c);
    scr_caught_release(c);
    return;
  }
  if (v == op_k_eof) {
    scr_dyn_release(v);
    map_finally(m);
    gen_complete(g, NULL);
    return;
  }
  if (op_aborted(m->signal)) {
    scr_dyn_release(v);
    ScrCaught *c = op_take_error(op_abort_error(NULL));
    map_finally(m);
    gen_complete(g, c);
    scr_caught_release(c);
    return;
  }
  if (v != op_k_empty) {
    gen_yield(g, v);
    scr_dyn_release(v);
    return;
  }
  scr_dyn_release(v);
  scr_dyn_release(m->queue[m->qh++]);
  map_maybe_resume(m);
  map_consume(m);
}

static void map_consume(OpMap *m) {
  if (map_qlen(m) > 0) {
    op_await_value(m->queue[m->qh], &map_cons_val_k, m);
    return;
  }
  m->next_p = scr_promise_new();
  op_await(m->next_p, &map_cons_next_k, m);
}

/* Resumed after a yield, or started: the first resumption starts the pump
 * (pump() runs before the consumer loop), a later one shifts the entry
 * that was yielded. */
static void map_resume(OpGen *g) {
  OpMap *m = (OpMap *)g;
  if (!m->started) {
    m->started = true;
    map_pump_next(m);
  } else {
    scr_dyn_release(m->queue[m->qh++]);
    map_maybe_resume(m);
  }
  map_consume(m);
}

/* A return or throw delivered at the yield: the finally block, then the
 * generator completes. */
static void map_ret(OpGen *g, ScrDyn *v) {
  (void)v;
  map_finally((OpMap *)g);
  gen_complete(g, NULL);
}

static void map_thr(OpGen *g, ScrCaught *c) {
  map_finally((OpMap *)g);
  gen_complete(g, c);
}

static OpMap *map_new(ScrStream *s, ScrDyn *fn, int mode, double concurrency, double hwm,
                      ScrDyn *signal) {
  OpMap *m = op_alloc(sizeof *m);
  gen_init(&m->g, &op_map_body_drop);
  m->g.resume = &map_resume;
  m->g.ret = &map_ret;
  m->g.thr = &map_thr;
  m->src.s = scr_stream_retain(s);
  m->fn = scr_dyn_retain(fn);
  m->signal = signal ? scr_dyn_retain(signal) : NULL;
  m->mode = mode;
  m->concurrency = concurrency;
  m->hwm = hwm;
  return m;
}

/* ── drop and take ─────────────────────────────────────────────────── */

/* async function* drop() / take(): `for await (const val of this)` with
 * the signal polled before the loop and at every value; take returns once
 * its count is spent, closing the source (which destroys it). */
typedef struct {
  OpGen g;
  OpSrc src;
  ScrDyn *signal; /* +1 or NULL */
  double number;
  bool take;
  bool started;
} OpSlice;

static void op_slice_body_drop(OpGen *g) {
  OpSlice *t = (OpSlice *)g;
  src_release(&t->src);
  if (t->signal) scr_dyn_release(t->signal);
  free(t);
}

static void slice_next(OpSlice *t);

/* AsyncIteratorClose(source), then the generator completes (with the
 * thrown exception when one is given). */
typedef struct {
  OpObj base;
  OpGen *g;
  ScrCaught *thrown; /* +1 or NULL */
} OpGenClose;

static void op_gen_close_drop(OpObj *o) {
  OpGenClose *c = (OpGenClose *)o;
  op_unref(c->g);
  if (c->thrown) scr_caught_release(c->thrown);
  free(c);
}

static void op_gen_close_k(void *self, ScrDyn *v) {
  OpGenClose *c = self;
  if (v) {
    scr_dyn_release(v);
    gen_complete(c->g, c->thrown);
    return;
  }
  /* A rejected return() replaces a normal completion; a throw keeps its
   * own exception. */
  ScrCaught *err = scr_exc_take();
  gen_complete(c->g, c->thrown ? c->thrown : err);
  scr_caught_release(err);
}

static void gen_close_source(OpGen *g, OpSrc *src, ScrCaught *thrown /*moves or NULL*/) {
  OpGenClose *c = op_alloc(sizeof *c);
  c->base.rc = 1;
  c->base.drop = &op_gen_close_drop;
  c->g = op_ref(g);
  c->thrown = thrown;
  ScrPromise *p = src_return(src);
  op_await(p, &op_gen_close_k, c);
  scr_promise_release(p);
  op_unref(c);
}

static void slice_val_k(void *self, ScrDyn *v) {
  OpSlice *t = self;
  if (!v) {
    ScrCaught *c = scr_exc_take();
    gen_complete(&t->g, c);
    scr_caught_release(c);
    return;
  }
  if (src_done(&t->src, v)) {
    scr_dyn_release(v);
    gen_complete(&t->g, NULL);
    return;
  }
  if (op_aborted(t->signal)) {
    scr_dyn_release(v);
    gen_close_source(&t->g, &t->src, op_take_error(op_abort_error(NULL)));
    return;
  }
  bool yield;
  if (t->take) {
    yield = t->number-- > 0;
  } else {
    yield = t->number-- <= 0;
  }
  if (yield) {
    gen_yield(&t->g, v);
    scr_dyn_release(v);
    return;
  }
  scr_dyn_release(v);
  if (t->take && t->number <= 0) {
    gen_close_source(&t->g, &t->src, NULL);
    return;
  }
  slice_next(t);
}

static void slice_next(OpSlice *t) {
  ScrPromise *p = src_next(&t->src);
  op_await(p, &slice_val_k, t);
  scr_promise_release(p);
}

static void slice_resume(OpGen *g) {
  OpSlice *t = (OpSlice *)g;
  if (!t->started) {
    t->started = true;
    if (op_aborted(t->signal)) {
      ScrCaught *c = op_take_error(op_abort_error(NULL));
      gen_complete(g, c);
      scr_caught_release(c);
      return;
    }
  } else if (t->take && t->number <= 0) {
    /* `if (number <= 0) return;` after the yield */
    gen_close_source(g, &t->src, NULL);
    return;
  }
  slice_next(t);
}

static void slice_ret(OpGen *g, ScrDyn *v) {
  (void)v;
  gen_close_source(g, &((OpSlice *)g)->src, NULL);
}

static void slice_thr(OpGen *g, ScrCaught *c) {
  gen_close_source(g, &((OpSlice *)g)->src, scr_caught_retain(c));
}

/* ── flatMap ───────────────────────────────────────────────────────── */

/* async function* flatMap() { for await (const val of values) yield* val; }
 * over map's generator. yield* over an array (or a string's code points)
 * goes through the async-from-sync iterator: each step resolves after the
 * element's PromiseResolve job, and yield* awaits that result before
 * yielding without a further await. */
typedef struct {
  OpGen g;
  OpSrc values; /* the map generator */
  ScrDyn *inner; /* +1: the array or string being delegated to, or NULL */
  size_t idx;    /* element index, or the string's byte offset */
  ScrPromise *step; /* the async-from-sync iterator result being awaited */
  bool started;
} OpFlat;

static void op_flat_body_drop(OpGen *g) {
  OpFlat *f = (OpFlat *)g;
  src_release(&f->values);
  if (f->inner) scr_dyn_release(f->inner);
  if (f->step) scr_promise_release(f->step);
  free(f);
}

static void flat_next_value(OpFlat *f);

/* The next element (+1), or NULL when the delegate is exhausted. */
static ScrDyn *flat_take_element(OpFlat *f) {
  ScrDyn *in = f->inner;
  if (in->kind == SCR_DYN_ARR) {
    if (f->idx >= in->v.arr.len) return NULL;
    ScrDyn *e = in->v.arr.items[f->idx++];
    return e ? scr_dyn_retain(e) : scr_dyn_retain(scr_dyn_undefined());
  }
  /* a string iterates by code point */
  const ScrStr *s = in->v.str;
  if (f->idx >= s->len) return NULL;
  size_t i = f->idx;
  unsigned char c = (unsigned char)s->data[i];
  size_t n = c < 0x80 ? 1 : c < 0xE0 ? 2 : c < 0xF0 ? 3 : 4;
  if (i + n > s->len) n = s->len - i;
  f->idx += n;
  ScrStr *piece = scr_str_new(s->data + i, n);
  ScrDyn *d = scr_dyn_new_str(piece);
  scr_str_release(piece);
  return d;
}

/* Await(innerResult): the iterator result is ready one job later. */
static void flat_step_k(void *self, ScrDyn *v) {
  OpFlat *f = self;
  if (f->step) {
    scr_promise_release(f->step);
    f->step = NULL;
  }
  if (v == op_k_done || (v && v == op_k_eof)) {
    scr_dyn_release(v);
    scr_dyn_release(f->inner);
    f->inner = NULL;
    flat_next_value(f);
    return;
  }
  gen_yield_now(&f->g, v);
  scr_dyn_release(v);
}

/* The async-from-sync continuation: PromiseResolve(value) then the result
 * promise settles; yield* awaits that promise. */
typedef struct {
  OpObj base;
  ScrPromise *p;
  bool done;
} OpFlatWrap;

static void op_flat_wrap_drop(OpObj *o) {
  OpFlatWrap *w = (OpFlatWrap *)o;
  scr_promise_release(w->p);
  free(w);
}

static void op_flat_wrap_k(void *self, ScrDyn *v) {
  OpFlatWrap *w = self;
  if (!v) {
    scr_promise_reject_pending(w->p);
    return;
  }
  op_fulfill(w->p, w->done ? op_k_done : v);
  scr_dyn_release(v);
}

static void flat_delegate_step(OpFlat *f) {
  ScrDyn *e = flat_take_element(f);
  OpFlatWrap *w = op_alloc(sizeof *w);
  w->base.rc = 1;
  w->base.drop = &op_flat_wrap_drop;
  w->p = scr_promise_new();
  w->done = e == NULL;
  f->step = scr_promise_retain(w->p);
  op_await_value(e ? e : scr_dyn_undefined(), &op_flat_wrap_k, w);
  if (e) scr_dyn_release(e);
  op_await(w->p, &flat_step_k, f);
  op_unref(w);
}

static void flat_val_k(void *self, ScrDyn *v) {
  OpFlat *f = self;
  if (!v) {
    ScrCaught *c = scr_exc_take();
    gen_complete(&f->g, c);
    scr_caught_release(c);
    return;
  }
  if (src_done(&f->values, v)) {
    scr_dyn_release(v);
    gen_complete(&f->g, NULL);
    return;
  }
  if (v->kind != SCR_DYN_ARR && v->kind != SCR_DYN_STR) {
    scr_dyn_release(v);
    ScrCaught *c = op_take_error(
        op_unsupported("flatMap callback results other than arrays or strings"));
    gen_close_source(&f->g, &f->values, c);
    return;
  }
  f->inner = v;
  f->idx = 0;
  flat_delegate_step(f);
}

static void flat_next_value(OpFlat *f) {
  ScrPromise *p = src_next(&f->values);
  op_await(p, &flat_val_k, f);
  scr_promise_release(p);
}

static void flat_resume(OpGen *g) {
  OpFlat *f = (OpFlat *)g;
  if (!f->started) {
    f->started = true;
    flat_next_value(f);
    return;
  }
  flat_delegate_step(f);
}

/* A return during delegation: the async-from-sync iterator's return()
 * resolves at once (arrays have no return method), yield* awaits it and
 * then the return value, and the return completion leaves the for await,
 * closing map's generator. */
typedef struct {
  OpObj base;
  OpFlat *f;
  int stage;
} OpFlatRet;

static void op_flat_ret_drop(OpObj *o) {
  OpFlatRet *r = (OpFlatRet *)o;
  op_unref(r->f);
  free(r);
}

static void op_flat_ret_k(void *self, ScrDyn *v) {
  OpFlatRet *r = self;
  if (v) scr_dyn_release(v);
  else scr_exc_clear();
  if (r->stage == 0) {
    r->stage = 1;
    op_await_value(scr_dyn_undefined(), &op_flat_ret_k, r);
    return;
  }
  if (r->f->inner) {
    scr_dyn_release(r->f->inner);
    r->f->inner = NULL;
  }
  gen_close_source(&r->f->g, &r->f->values, NULL);
}

static void flat_ret(OpGen *g, ScrDyn *v) {
  (void)v;
  OpFlatRet *r = op_alloc(sizeof *r);
  r->base.rc = 1;
  r->base.drop = &op_flat_ret_drop;
  r->f = op_ref((OpFlat *)g);
  op_await_value(scr_dyn_undefined(), &op_flat_ret_k, r);
  op_unref(r);
}

/* A throw during delegation: the array iterator has no throw method, so
 * yield* rejects with Node's TypeError, which leaves the for await and
 * closes map's generator. */
static void flat_thr(OpGen *g, ScrCaught *c) {
  (void)c;
  OpFlat *f = (OpFlat *)g;
  if (f->inner) {
    scr_dyn_release(f->inner);
    f->inner = NULL;
  }
  ScrError *e = op_coded_error(SCR_ERR_TYPE, NULL, "The iterator does not provide a 'throw' method.");
  gen_close_source(g, &f->values, op_take_error(e));
}

/* ── Readable.from(generator) ──────────────────────────────────────── */

/* The operator's output stream: from.js's nextAsync pulls the generator
 * while push() accepts, and _destroy runs close(error) (the generator's
 * throw, then return) before the destroy callback, on a nextTick. */
enum { FROM_OP, FROM_SYNC, FROM_ASYNC, FROM_DYN };

typedef struct {
  OpObj base;
  int kind;
  OpGen *g;        /* +1 (FROM_OP: an operator's generator) */
  /* FROM_SYNC / FROM_ASYNC: a compiled generator and the compiler's
   * helpers over it (+1 each). next/ret/thr answer the next value or the
   * done marker (sync), or the resume's promise (async, read through
   * `read`). */
  ScrGen *gen;
  ScrClosure *next, *ret, *thr, *read;
  /* FROM_DYN: the checked-dynamic iterator from.js keeps (+1), and
   * whether it came from Symbol.asyncIterator */
  ScrDyn *iter;
  bool async_iter;
  ScrStream *out;  /* borrowed: the stream owns this object */
  bool reading;
} OpFrom;

static void op_from_drop(OpObj *o) {
  OpFrom *f = (OpFrom *)o;
  if (f->g) op_unref(f->g);
  scr_gen_release(f->gen);
  if (f->next) scr_closure_release(f->next);
  if (f->ret) scr_closure_release(f->ret);
  if (f->thr) scr_closure_release(f->thr);
  if (f->read) scr_closure_release(f->read);
  if (f->iter) scr_dyn_release(f->iter);
  free(f);
}

/* The helper ABIs: the closure first, then the declared parameters, which
 * the callee owns. */
typedef ScrDyn *(*FromSyncFn)(ScrClosure *, ScrGen *);
typedef ScrDyn *(*FromSyncThrowFn)(ScrClosure *, ScrGen *, ScrDyn *);
typedef ScrPromise *(*FromAsyncFn)(ScrClosure *, ScrGen *);
typedef ScrPromise *(*FromAsyncThrowFn)(ScrClosure *, ScrGen *, ScrDyn *);
typedef ScrDyn *(*FromReadFn)(ScrClosure *, void *);

/* `await p` over an async generator's resume promise: the IteratorResult
 * record goes through `read` (the value, or the done marker) before k.
 * Awaiting the typed promise itself keeps from.js's single await. */
typedef struct {
  void *self;
  OpCont k;
  ScrPromise *p;
  ScrClosure *read;
} OpAwaitGen;

static void op_await_gen_entry(ScrFiber *fiber, void *arg) {
  (void)fiber;
  OpAwaitGen a = *(OpAwaitGen *)arg;
  free(arg);
  void *rec = scr_await_ref(a.p);
  scr_promise_release(a.p);
  ScrDyn *v = scr_exc_pending() ? NULL : ((FromReadFn)a.read->fn)(a.read, rec);
  scr_closure_release(a.read);
  a.k(a.self, v);
  if (scr_exc_pending()) scr_exc_clear();
  op_unref(a.self);
}

static void op_await_gen(ScrPromise *p, ScrClosure *read, OpCont k, void *self) {
  OpAwaitGen *a = op_alloc(sizeof *a);
  a->self = op_ref(self);
  a->k = k;
  a->p = scr_promise_retain(p);
  a->read = scr_closure_retain(read);
  ScrPromise *fiber = scr_async_spawn_after(p, &op_await_gen_entry, a);
  scr_promise_release(fiber);
}

/* One pull: the stream is held for the await. */
typedef struct {
  OpObj base;
  OpFrom *from;
  ScrStream *out; /* +1 */
} OpFromStep;

static void op_from_step_drop(OpObj *o) {
  OpFromStep *st = (OpFromStep *)o;
  op_unref(st->from);
  scr_stream_release(st->out);
  free(st);
}

static void from_next(OpFrom *f, ScrStream *out);

/* An operator error as a stream error: Error values as themselves, any
 * other thrown value refused. +1. */
static ScrError *op_caught_error(const ScrCaught *c) {
  ScrDyn *d = scr_caught_to_dyn(c);
  ScrError *e = d ? scr_errdyn_err_of(d) : NULL;
  if (d) scr_dyn_release(d);
  if (e) return e;
  return op_unsupported("a stream operator rejection that is not an Error object");
}

static void op_from_destroy_with(ScrStream *out, ScrError *e /*moves*/) {
  scr_stream_release(scr_stream_destroy(out, e));
  scr_error_release(e);
}

/* A compiled generator's value: from.js's push, with null and values
 * other than strings or Buffers destroying the stream. Answers whether
 * to pull again. Moves v (NULL: the resume threw, pending). */
static bool from_take(OpFrom *f, ScrStream *out, ScrDyn *v) {
  if (!v) {
    ScrCaught *c = scr_exc_take();
    op_from_destroy_with(out, op_caught_error(c));
    scr_caught_release(c);
    return false;
  }
  if (v == op_k_done) {
    scr_dyn_release(v);
    scr_stream_push_null(out);
    return false;
  }
  if (v->kind == SCR_DYN_NULL) f->reading = false;
  int pushed = scr_stream_from_push(out, v);
  scr_dyn_release(v);
  if (pushed < 0 || scr_exc_pending()) return false;
  if (pushed) return true;
  f->reading = false;
  return false;
}

static void op_from_step_k(void *self, ScrDyn *v) {
  OpFromStep *st = self;
  OpFrom *f = st->from;
  ScrStream *out = st->out;
  if (f->kind != FROM_OP) {
    if (from_take(f, out, v)) from_next(f, out);
    return;
  }
  if (!v) {
    ScrCaught *c = scr_exc_take();
    op_from_destroy_with(out, op_caught_error(c));
    scr_caught_release(c);
    return;
  }
  if (v == op_k_done) {
    scr_dyn_release(v);
    scr_stream_push_null(out);
    return;
  }
  if (v->kind == SCR_DYN_NULL) {
    scr_dyn_release(v);
    f->reading = false;
    op_from_destroy_with(out, op_coded_error(SCR_ERR_TYPE, "ERR_STREAM_NULL_VALUES",
                                             "May not write null values to stream"));
    return;
  }
  int pushed = scr_stream_push_object(out, v);
  scr_dyn_release(v);
  if (pushed) {
    from_next(f, out);
    return;
  }
  f->reading = false;
}

/* iterator[name](...args): the method is read through the property on
 * every call. +1, or NULL with the error pending ("<what> is not a
 * function" for a method that cannot be called). */
static ScrDyn *from_dyn_call(const ScrDyn *iter, const char *name, ScrDyn *const *args,
                             size_t argc, const char *what) {
  ScrDyn *m = scr_dyn_iterator_result_get(iter, name, strlen(name));
  if (!m) return NULL;
  scr_dyn_this_push_dyn(iter);
  ScrDyn *r = scr_dyn_call(m, args, argc, what);
  scr_dyn_this_pop();
  scr_dyn_release(m);
  return r;
}

/* `const { value, done } = result` over an iterator result: value, then
 * done, each read once. what spells the result expression in the
 * TypeError for a nullish result. +1 value with *done set, or NULL with
 * the error pending. Borrows r. */
static ScrDyn *from_dyn_result(const ScrDyn *r, const char *what, bool *done) {
  if (r->kind == SCR_DYN_UNDEF || r->kind == SCR_DYN_NULL) {
    char msg[160];
    int n = snprintf(msg, sizeof msg, "Cannot destructure property 'value' of '%s' as it is %s.",
                     what, r->kind == SCR_DYN_UNDEF ? "undefined" : "null");
    scr_throw_error_msg(SCR_ERR_TYPE, msg, (size_t)n);
    return NULL;
  }
  ScrDyn *v = scr_dyn_iterator_result_get(r, "value", 5);
  if (!v) return NULL;
  ScrDyn *d = scr_dyn_iterator_result_get(r, "done", 4);
  if (!d) {
    scr_dyn_release(v);
    return NULL;
  }
  *done = scr_dyn_truthy(d);
  scr_dyn_release(d);
  return v;
}

/* `value && typeof value.then === 'function'`: 1 for a promise, 0 for
 * no then method, -1 for another thenable (refused: the await of a
 * non-promise thenable has no lowering), -2 with the error pending. */
static int from_dyn_thenable(const ScrDyn *v) {
  if (v->kind == SCR_DYN_PROMISE) return 1;
  if (!scr_dyn_truthy(v)) return 0;
  if (v->kind != SCR_DYN_OBJ && v->kind != SCR_DYN_FUNC && v->kind != SCR_DYN_PROXY &&
      v->kind != SCR_DYN_TYPED_REF) {
    return 0;
  }
  ScrDyn *then = scr_dyn_iterator_result_get(v, "then", 4);
  if (!then) return -2;
  bool callable = scr_dyn_is_callable(then);
  scr_dyn_release(then);
  return callable ? -1 : 0;
}

static OpFromStep *from_step_new(OpFrom *f, ScrStream *out) {
  OpFromStep *st = op_alloc(sizeof *st);
  st->base.rc = 1;
  st->base.drop = &op_from_step_drop;
  st->from = op_ref(f);
  st->out = scr_stream_retain(out);
  return st;
}

/* nextAsync's `await iterator.next()` result, destructured: the value,
 * the done marker, or NULL (the await rejected or the result read threw,
 * pending). Moves r. */
static ScrDyn *from_dyn_async_result(ScrDyn *r) {
  if (!r) return NULL;
  bool done = false;
  ScrDyn *v = from_dyn_result(r, "(intermediate value)", &done);
  scr_dyn_release(r);
  if (v && done) {
    scr_dyn_release(v);
    return scr_dyn_retain(op_k_done);
  }
  return v;
}

static void op_from_dyn_async_k(void *self, ScrDyn *r) {
  OpFromStep *st = self;
  if (from_take(st->from, st->out, from_dyn_async_result(r))) {
    from_next(st->from, st->out);
  }
}

/* from.js over a checked-dynamic iterator. A sync iterator pushes while
 * push() accepts and awaits only promise values (nextSyncWithSyncValues,
 * changeToAsyncValues and nextSyncWithAsyncValues behave the same way);
 * an async iterator awaits each next() result (nextAsync). Each pull
 * calls iterator.next() through its property. */
static void from_dyn_next(OpFrom *f, ScrStream *out) {
  if (f->async_iter) {
    ScrDyn *r = from_dyn_call(f->iter, "next", NULL, 0, "iterator.next");
    if (!r) {
      from_take(f, out, NULL);
      return;
    }
    OpFromStep *st = from_step_new(f, out);
    op_await_value(r, &op_from_dyn_async_k, st);
    scr_dyn_release(r);
    op_unref(st);
    return;
  }
  for (;;) {
    ScrDyn *r = from_dyn_call(f->iter, "next", NULL, 0, "iterator.next");
    bool done = false;
    ScrDyn *v = NULL;
    if (r) {
      v = from_dyn_result(r, "iterator.next(...)", &done);
      scr_dyn_release(r);
    }
    if (v && done) {
      scr_dyn_release(v);
      v = scr_dyn_retain(op_k_done);
    } else if (v) {
      int thenable = from_dyn_thenable(v);
      if (thenable == 1) {
        OpFromStep *st = from_step_new(f, out);
        op_await_value(v, &op_from_step_k, st);
        scr_dyn_release(v);
        op_unref(st);
        return;
      }
      if (thenable < 0) {
        scr_dyn_release(v);
        v = NULL;
        if (thenable == -1) {
          ScrError *e = op_unsupported("Readable.from over a value with a then method that is not a promise");
          scr_throw_obj(e, &scr_error_retain_v, &scr_error_release_v, scr_error_trace_arg());
        }
      }
    }
    if (!from_take(f, out, v)) return;
  }
}

static void from_next(OpFrom *f, ScrStream *out) {
  if (f->kind == FROM_DYN) {
    from_dyn_next(f, out);
    return;
  }
  if (f->kind == FROM_SYNC) {
    /* nextSyncWithSyncValues: no awaits between the pushes */
    while (from_take(f, out, ((FromSyncFn)f->next->fn)(f->next, scr_gen_retain(f->gen)))) {
    }
    return;
  }
  OpFromStep *st = op_alloc(sizeof *st);
  st->base.rc = 1;
  st->base.drop = &op_from_step_drop;
  st->from = op_ref(f);
  st->out = scr_stream_retain(out);
  if (f->kind == FROM_ASYNC) {
    ScrPromise *p = ((FromAsyncFn)f->next->fn)(f->next, scr_gen_retain(f->gen));
    op_await_gen(p, f->read, &op_from_step_k, st);
    scr_promise_release(p);
  } else {
    ScrPromise *p = gen_next(f->g);
    op_await(p, &op_from_step_k, st);
    scr_promise_release(p);
  }
  op_unref(st);
}

static OpFrom *op_from_of(ScrClosure *cb) { return scr_box_get_ref(cb->caps[0]); /* +1 */ }

/* readable._read */
static void op_from_read_inv(ScrClosure *cb, ScrStream *s, double size) {
  (void)size;
  OpFrom *f = op_from_of(cb);
  if (!f->reading) {
    f->reading = true;
    from_next(f, s);
  }
  op_unref(f);
}

/* close(error): `await iterator.throw(error)` (when there is an error),
 * `await value`, then `await iterator.return()` and `await value`; the
 * destroy callback follows on a nextTick from the promise's reaction. */
typedef struct {
  OpObj base;
  OpFrom *from;
  ScrStream *out;  /* +1 */
  ScrError *error; /* +1, the destroy error, or NULL */
  ScrError *fail;  /* +1, close()'s rejection */
  int stage;
  bool thr_done;   /* FROM_DYN: the throw() result's done */
} OpFromClose;

static void op_from_close_drop(OpObj *o) {
  OpFromClose *c = (OpFromClose *)o;
  op_unref(c->from);
  scr_stream_release(c->out);
  if (c->error) scr_error_release(c->error);
  if (c->fail) scr_error_release(c->fail);
  free(c);
}

/* aggregateTwoErrors(inner, outer) from internal/errors.js: two distinct
 * errors become an AggregateError of [outer, inner] with outer's message
 * and code, or inner joins outer.errors when that is an array; otherwise
 * whichever is set. +1, or NULL for neither. */
static ScrError *op_aggregate_two(ScrError *inner, ScrError *outer) {
  if (!inner || !outer || inner == outer) {
    ScrError *e = inner ? inner : outer;
    return e ? scr_error_retain(e) : NULL;
  }
  ScrDyn *od = scr_dyn_from_error(outer);
  ScrDyn *list = od ? scr_dyn_iterator_result_get(od, "errors", 6) : NULL;
  if (list && list->kind == SCR_DYN_ARR) {
    scr_dyn_arr_push(list, scr_dyn_from_error(inner));
    scr_dyn_release(list);
    scr_dyn_release(od);
    return scr_error_retain(outer);
  }
  if (list) scr_dyn_release(list);
  /* err.code = outerError.code: a code assigned in JavaScript is a
   * property of the error's checked-dynamic view */
  ScrDyn *code = od ? scr_dyn_iterator_result_get(od, "code", 4) : NULL;
  if (od) scr_dyn_release(od);
  if (scr_exc_pending()) scr_exc_clear();
  ScrDyn *m = scr_dyn_new_str(outer->message);
  ScrError *e = scr_aggregate_new(m, scr_dyn_undefined());
  scr_dyn_release(m);
  if (!e) {
    scr_exc_clear();
    if (code) scr_dyn_release(code);
    return scr_error_retain(outer);
  }
  ScrDyn *errors = scr_dyn_new_arr();
  scr_dyn_arr_push(errors, scr_dyn_from_error(outer));
  scr_dyn_arr_push(errors, scr_dyn_from_error(inner));
  scr_aggregate_set_errors(e, errors);
  scr_dyn_release(errors);
  if (code && code->kind == SCR_DYN_STR) e->code = scr_str_retain(code->v.str);
  if (code) scr_dyn_release(code);
  return e;
}

static void op_from_cb_tick(ScrClosure *job) {
  OpFromClose *c = scr_box_get_ref(job->caps[0]);
  /* cb(combinedError), or cb(aggregateTwoErrors(combinedError, closeError)) */
  scr_stream_destroy_done(c->out, op_aggregate_two(c->error, c->fail));
  op_unref(c);
}

static void op_from_close_settled(OpFromClose *c) {
  /* PromisePrototypeThen(close(error), ...): the reaction job, then
   * process.nextTick(cb, ...) */
  ScrClosure *job = scr_closure_new((void *)&op_from_cb_tick, 1);
  job->caps[0] = scr_box_new_obj(&op_ref, &op_unref, NULL);
  scr_box_set_ref(job->caps[0], op_ref(c));
  scr_next_tick(job);
}

static void op_from_close_k(void *self, ScrDyn *v);

static void op_from_close_step(OpFromClose *c, ScrPromise *p) {
  op_await(p, &op_from_close_k, c);
  scr_promise_release(p);
}

/* `await iterator.throw(error)` (err set) or `await iterator.return()`:
 * op_from_close_k receives the result's value, or the done marker. A
 * compiled sync generator answers at once (one job for the await); a
 * compiled async generator answers through its promise. */
static void from_close_resume(OpFromClose *c, ScrError *err) {
  OpFrom *f = c->from;
  if (f->kind == FROM_OP) {
    if (err) {
      ScrCaught *thrown = op_take_error(scr_error_retain(err));
      op_from_close_step(c, gen_throw(f->g, thrown));
      scr_caught_release(thrown);
    } else {
      op_from_close_step(c, gen_return(f->g, scr_dyn_undefined()));
    }
    return;
  }
  ScrDyn *e = err ? scr_dyn_from_error(err) : NULL;
  if (f->kind == FROM_SYNC) {
    ScrDyn *v = e ? ((FromSyncThrowFn)f->thr->fn)(f->thr, scr_gen_retain(f->gen), e)
                  : ((FromSyncFn)f->ret->fn)(f->ret, scr_gen_retain(f->gen));
    if (!v) {
      op_from_close_k(c, NULL); /* close() rejects without an await */
      return;
    }
    op_await_value(v, &op_from_close_k, c);
    scr_dyn_release(v);
    return;
  }
  ScrPromise *p = e ? ((FromAsyncThrowFn)f->thr->fn)(f->thr, scr_gen_retain(f->gen), e)
                    : ((FromAsyncFn)f->ret->fn)(f->ret, scr_gen_retain(f->gen));
  op_await_gen(p, f->read, &op_from_close_k, c);
  scr_promise_release(p);
}

static void op_from_close_k(void *self, ScrDyn *v) {
  OpFromClose *c = self;
  if (!v) {
    ScrCaught *err = scr_exc_take();
    c->fail = op_caught_error(err);
    scr_caught_release(err);
    c->stage = 9;
    op_await_value(scr_dyn_undefined(), &op_from_close_k, c);
    return;
  }
  bool done = v == op_k_done;
  scr_dyn_release(v);
  switch (c->stage) {
  case 0: /* await iterator.throw(error) */
    c->stage = done ? 2 : 1;
    op_await_value(scr_dyn_undefined(), &op_from_close_k, c); /* await value */
    return;
  case 1: /* not done: iterator.return() */
  case 3:
    c->stage = 4;
    from_close_resume(c, NULL);
    return;
  case 2: /* done after the throw: close() returns */
  case 5:
  case 9:
    op_from_close_settled(c);
    return;
  case 4: /* await iterator.return() */
    c->stage = 5;
    op_await_value(scr_dyn_undefined(), &op_from_close_k, c); /* await value */
    return;
  default:
    op_from_close_settled(c);
  }
}

/* close(error) over a checked-dynamic iterator: `typeof iterator.throw`
 * and `typeof iterator.return` are read when close runs, and each result
 * is destructured and its value awaited as in from.js. Stages 20/21 await
 * throw()'s result and value, 22/23 return()'s, and 24 is the job of a
 * close that awaited nothing. */
static void op_from_dyn_close_k(void *self, ScrDyn *v);

/* typeof iterator[name] === 'function': 1, 0, or -1 with the error
 * pending. */
static int from_dyn_has_method(const ScrDyn *iter, const char *name, size_t len) {
  ScrDyn *m = scr_dyn_iterator_result_get(iter, name, len);
  if (!m) return -1;
  bool callable = scr_dyn_is_callable(m);
  scr_dyn_release(m);
  return callable ? 1 : 0;
}

/* Calls iterator[name](args) and awaits the result at stage. */
static void from_dyn_close_call(OpFromClose *c, const char *name, ScrDyn *const *args,
                                size_t argc, int stage) {
  char what[16];
  snprintf(what, sizeof what, "iterator.%s", name);
  ScrDyn *r = from_dyn_call(c->from->iter, name, args, argc, what);
  if (!r) {
    op_from_close_k(c, NULL);
    return;
  }
  c->stage = stage;
  op_await_value(r, &op_from_dyn_close_k, c);
  scr_dyn_release(r);
}

static void from_dyn_close_return(OpFromClose *c) {
  int has = from_dyn_has_method(c->from->iter, "return", 6);
  if (has < 0) {
    op_from_close_k(c, NULL);
    return;
  }
  if (has) {
    from_dyn_close_call(c, "return", NULL, 0, 22);
    return;
  }
  c->stage = 24;
  op_await_value(scr_dyn_undefined(), &op_from_dyn_close_k, c);
}

static void from_dyn_close_start(OpFromClose *c) {
  if (c->error) {
    int has = from_dyn_has_method(c->from->iter, "throw", 5);
    if (has < 0) {
      op_from_close_k(c, NULL);
      return;
    }
    if (has) {
      ScrDyn *e = scr_dyn_from_error(c->error);
      from_dyn_close_call(c, "throw", &e, 1, 20);
      scr_dyn_release(e);
      return;
    }
  }
  from_dyn_close_return(c);
}

static void op_from_dyn_close_k(void *self, ScrDyn *v) {
  OpFromClose *c = self;
  if (!v) {
    op_from_close_k(c, NULL);
    return;
  }
  switch (c->stage) {
  case 20:   /* const { value, done } = await iterator.throw(error) */
  case 22: { /* const { value } = await iterator.return() */
    bool done = false;
    ScrDyn *value = from_dyn_result(v, "(intermediate value)", &done);
    scr_dyn_release(v);
    if (!value) {
      op_from_close_k(c, NULL);
      return;
    }
    c->thr_done = done;
    c->stage++;
    op_await_value(value, &op_from_dyn_close_k, c); /* await value */
    scr_dyn_release(value);
    return;
  }
  case 21: /* if (done) return; */
    scr_dyn_release(v);
    if (c->thr_done) op_from_close_settled(c);
    else from_dyn_close_return(c);
    return;
  default: /* 23, 24 */
    scr_dyn_release(v);
    op_from_close_settled(c);
  }
}

static void op_from_destroy_inv(ScrClosure *cb, ScrStream *s, ScrError *err) {
  OpFrom *f = op_from_of(cb);
  OpFromClose *c = op_alloc(sizeof *c);
  c->base.rc = 1;
  c->base.drop = &op_from_close_drop;
  c->from = f; /* the +1 from op_from_of moves here */
  c->out = scr_stream_retain(s);
  c->error = err ? scr_error_retain(err) : NULL;
  if (f->kind == FROM_DYN) {
    from_dyn_close_start(c);
  } else {
    c->stage = err ? 0 : 4;
    from_close_resume(c, err);
  }
  op_unref(c);
}

static ScrClosure *op_from_closure(void *fn, OpFrom *f) {
  ScrClosure *c = scr_closure_new(fn, 1);
  c->caps[0] = scr_box_new_obj(&op_ref, &op_unref, NULL);
  scr_box_set_ref(c->caps[0], op_ref(f));
  return c;
}

/* Readable.from(generator): +1 object-mode stream (hwm 1). Moves g. */
static ScrStream *op_from_gen(OpGen *g) {
  OpFrom *f = op_alloc(sizeof *f);
  f->base.rc = 1;
  f->base.drop = &op_from_drop;
  f->g = g;
  ScrStream *out = scr_stream_new_object_readable(op_from_closure((void *)&op_from_read_inv, f),
                                                  &op_from_read_inv,
                                                  op_from_closure((void *)&op_from_destroy_inv, f),
                                                  &op_from_destroy_inv);
  f->out = out;
  op_unref(f);
  return out;
}

/* Readable.from over a compiled generator (the compiler's helpers move
 * in, borrowed; g borrowed). +1, or NULL with ERR_INVALID_ARG_VALUE
 * pending for a bad highWaterMark. */
static ScrStream *op_from_compiled(int kind, ScrGen *g, ScrClosure *next, ScrClosure *read,
                                   ScrClosure *ret, ScrClosure *thr, double flags, double hwm) {
  OpFrom *f = op_alloc(sizeof *f);
  f->base.rc = 1;
  f->base.drop = &op_from_drop;
  f->kind = kind;
  f->gen = scr_gen_retain(g);
  f->next = scr_closure_retain(next);
  f->read = read ? scr_closure_retain(read) : NULL;
  f->ret = scr_closure_retain(ret);
  f->thr = scr_closure_retain(thr);
  ScrStream *out = scr_stream_new_from_readable(op_from_closure((void *)&op_from_read_inv, f),
                                                &op_from_read_inv,
                                                op_from_closure((void *)&op_from_destroy_inv, f),
                                                &op_from_destroy_inv, flags, hwm);
  f->out = out;
  op_unref(f);
  return out;
}

ScrStream *scr_stream_from_gen(ScrGen *g, ScrClosure *next, ScrClosure *ret, ScrClosure *thr,
                               double flags, double hwm) {
  op_sentinels_init();
  return op_from_compiled(FROM_SYNC, g, next, NULL, ret, thr, flags, hwm);
}

ScrStream *scr_stream_from_async_gen(ScrGen *g, ScrClosure *next, ScrClosure *read,
                                     ScrClosure *ret, ScrClosure *thr, double flags,
                                     double hwm) {
  op_sentinels_init();
  return op_from_compiled(FROM_ASYNC, g, next, read, ret, thr, flags, hwm);
}

ScrStream *scr_stream_from_dyn_iter(ScrDyn *iter, bool async_iter, double flags, double hwm) {
  op_sentinels_init();
  OpFrom *f = op_alloc(sizeof *f);
  f->base.rc = 1;
  f->base.drop = &op_from_drop;
  f->kind = FROM_DYN;
  f->iter = iter;
  f->async_iter = async_iter;
  ScrStream *out = scr_stream_new_from_readable(op_from_closure((void *)&op_from_read_inv, f),
                                                &op_from_read_inv,
                                                op_from_closure((void *)&op_from_destroy_inv, f),
                                                &op_from_destroy_inv, flags, hwm);
  f->out = out;
  op_unref(f);
  return out;
}

ScrStream *scr_stream_from_iter(ScrDyn *iter, double flags, double hwm) {
  return scr_stream_from_dyn_iter(scr_dyn_retain(iter), false, flags, hwm);
}

ScrStream *scr_stream_from_async_iter(ScrDyn *iter, double flags, double hwm) {
  return scr_stream_from_dyn_iter(scr_dyn_retain(iter), true, flags, hwm);
}

/* ── the promise operators ─────────────────────────────────────────── */

enum { PK_DYN, PK_F64, PK_BOOL, PK_STR, PK_VOID };

/* An async operator function: its promise and the loop state. */
typedef struct {
  OpObj base;
  ScrPromise *p;
  OpSrc src;
  ScrDyn *fn;     /* +1 or NULL */
  ScrDyn *signal; /* +1 or NULL */
  ScrDyn *acc;    /* toArray's array / reduce's accumulator (+1) */
  int op;
  int kind;       /* the promise payload (PK_*) */
  bool has_init, got_any, negate;
} OpFn;

enum { FN_TO_ARRAY, FN_REDUCE, FN_SOME, FN_FIND, FN_EVERY, FN_FOR_EACH };

static void op_fn_drop(OpObj *o) {
  OpFn *a = (OpFn *)o;
  scr_promise_release(a->p);
  src_release(&a->src);
  if (a->fn) scr_dyn_release(a->fn);
  if (a->signal) scr_dyn_release(a->signal);
  if (a->acc) scr_dyn_release(a->acc);
  free(a);
}

static OpFn *op_fn_new(int op, int kind) {
  OpFn *a = op_alloc(sizeof *a);
  a->base.rc = 1;
  a->base.drop = &op_fn_drop;
  a->p = scr_promise_new();
  a->op = op;
  a->kind = kind;
  return a;
}

/* Settles the operator's promise with v converted to its payload kind (a
 * value of the wrong kind rejects with the checked conversion's error). */
static void op_fn_resolve(OpFn *a, ScrDyn *v /*borrowed*/) {
  switch (a->kind) {
  case PK_VOID:
    scr_promise_fulfill_void(a->p);
    return;
  case PK_BOOL:
    scr_promise_fulfill_bool(a->p, scr_dyn_truthy(v));
    return;
  case PK_F64:
    if (v->kind != SCR_DYN_NUM) break;
    scr_promise_fulfill_f64(a->p, v->v.num);
    return;
  case PK_STR:
    if (v->kind != SCR_DYN_STR) break;
    scr_promise_fulfill_str(a->p, scr_str_retain(v->v.str));
    return;
  default:
    op_fulfill(a->p, v);
    return;
  }
  static const char m[] = "reduce result does not match its declared type";
  scr_throw_error_msg(SCR_ERR_TYPE, m, sizeof m - 1);
  scr_promise_reject_pending(a->p);
}

static void op_fn_reject(OpFn *a, const ScrCaught *c) { op_reject(a->p, c); }

static void op_fn_next(OpFn *a);

/* After the loop's AsyncIteratorClose: the throw that left the loop, or
 * the early return's result. */
typedef struct {
  OpObj base;
  OpFn *a;
  ScrCaught *thrown; /* +1 or NULL */
  ScrDyn *result;    /* +1 or NULL */
} OpFnClose;

static void op_fn_close_drop(OpObj *o) {
  OpFnClose *c = (OpFnClose *)o;
  op_unref(c->a);
  if (c->thrown) scr_caught_release(c->thrown);
  if (c->result) scr_dyn_release(c->result);
  free(c);
}

static void op_fn_finish(OpFn *a, ScrDyn *result);

static void op_fn_close_k(void *self, ScrDyn *v) {
  OpFnClose *c = self;
  if (v) {
    scr_dyn_release(v);
  } else if (!c->thrown) {
    ScrCaught *err = scr_exc_take();
    op_fn_reject(c->a, err);
    scr_caught_release(err);
    return;
  } else {
    scr_exc_clear();
  }
  if (c->thrown) op_fn_reject(c->a, c->thrown);
  else op_fn_finish(c->a, c->result);
}

static void op_fn_close(OpFn *a, ScrCaught *thrown /*moves*/, ScrDyn *result /*moves*/) {
  OpFnClose *c = op_alloc(sizeof *c);
  c->base.rc = 1;
  c->base.drop = &op_fn_close_drop;
  c->a = op_ref(a);
  c->thrown = thrown;
  c->result = result;
  ScrPromise *p = src_return(&a->src);
  op_await(p, &op_fn_close_k, c);
  scr_promise_release(p);
  op_unref(c);
}

/* every: `!(await some(...))` — one more job after some's result. */
static void op_every_k(void *self, ScrDyn *v) {
  OpFn *a = self;
  if (!v) {
    scr_promise_reject_pending(a->p);
    return;
  }
  scr_promise_fulfill_bool(a->p, !scr_dyn_truthy(v));
  scr_dyn_release(v);
}

static void op_fn_finish(OpFn *a, ScrDyn *result) {
  op_fn_resolve(a, result ? result : scr_dyn_undefined());
}

static void op_reduce_value_k(void *self, ScrDyn *v) {
  OpFn *a = self;
  if (!v) {
    /* the rejection leaves the for await: AsyncIteratorClose */
    op_fn_close(a, scr_exc_take(), NULL);
    return;
  }
  scr_dyn_release(a->acc);
  a->acc = v;
  op_fn_next(a);
}

static void op_fn_val_k(void *self, ScrDyn *v) {
  OpFn *a = self;
  if (!v) {
    ScrCaught *c = scr_exc_take();
    op_fn_reject(a, c);
    scr_caught_release(c);
    return;
  }
  if (src_done(&a->src, v)) {
    scr_dyn_release(v);
    switch (a->op) {
    case FN_TO_ARRAY:
    case FN_REDUCE:
      if (a->op == FN_REDUCE && !a->got_any && !a->has_init) {
        ScrError *e = op_coded_error(SCR_ERR_TYPE, "ERR_MISSING_ARGS",
                                     "Reduce of an empty stream requires an initial value");
        ScrCaught *c = op_take_error(e);
        op_fn_reject(a, c);
        scr_caught_release(c);
        return;
      }
      op_fn_finish(a, a->acc);
      return;
    case FN_SOME:
    case FN_EVERY: {
      ScrDyn *f = scr_dyn_new_bool(false);
      op_fn_finish(a, f);
      scr_dyn_release(f);
      return;
    }
    default:
      op_fn_finish(a, NULL);
      return;
    }
  }
  switch (a->op) {
  case FN_TO_ARRAY:
    if (op_aborted(a->signal)) {
      ScrDyn *reason = op_get(a->signal, "reason");
      ScrError *e = op_abort_error(reason ? reason : scr_dyn_undefined());
      if (reason) scr_dyn_release(reason);
      scr_dyn_release(v);
      op_fn_close(a, op_take_error(e), NULL);
      return;
    }
    scr_dyn_arr_push(a->acc, v); /* moves v */
    op_fn_next(a);
    return;
  case FN_REDUCE: {
    a->got_any = true;
    if (op_aborted(a->signal)) {
      scr_dyn_release(v);
      op_fn_close(a, op_take_error(op_abort_error(NULL)), NULL);
      return;
    }
    if (!a->has_init) {
      scr_dyn_release(a->acc);
      a->acc = v;
      a->has_init = true;
      op_fn_next(a);
      return;
    }
    ScrDyn *args[2] = {a->acc, v};
    ScrDyn *r = scr_dyn_call(a->fn, args, 2, "reducer");
    scr_dyn_release(v);
    if (!r) {
      op_fn_close(a, scr_exc_take(), NULL);
      return;
    }
    op_await_value(r, &op_reduce_value_k, a);
    scr_dyn_release(r);
    return;
  }
  case FN_SOME:
  case FN_EVERY: {
    scr_dyn_release(v);
    op_fn_close(a, NULL, scr_dyn_new_bool(true));
    return;
  }
  case FN_FIND:
    op_fn_close(a, NULL, v);
    return;
  default: /* forEach never receives a value */
    scr_dyn_release(v);
    op_fn_next(a);
    return;
  }
}

static void op_fn_next(OpFn *a) {
  ScrPromise *p = src_next(&a->src);
  op_await(p, &op_fn_val_k, a);
  scr_promise_release(p);
}

/* ── validation and entry points ───────────────────────────────────── */

/* map()'s option reading: concurrency, highWaterMark (MathFloor, then
 * validateInteger). False with the error pending. */
static bool op_map_options(const ScrDyn *options, double *concurrency, double *hwm) {
  *concurrency = 1;
  ScrDyn *c = op_get(options, "concurrency");
  if (!op_nullish(c)) {
    double n = scr_dyn_number_coerce(c);
    if (scr_exc_pending()) {
      scr_dyn_release(c);
      return false;
    }
    *concurrency = floor(n);
  }
  if (c) scr_dyn_release(c);
  *hwm = *concurrency - 1;
  ScrDyn *h = op_get(options, "highWaterMark");
  if (!op_nullish(h)) {
    double n = scr_dyn_number_coerce(h);
    if (scr_exc_pending()) {
      scr_dyn_release(h);
      return false;
    }
    *hwm = floor(n);
  }
  if (h) scr_dyn_release(h);
  const double max = 9007199254740991.0;
  if (!isfinite(*concurrency) || floor(*concurrency) != *concurrency) {
    op_throw_out_of_range("options.concurrency", "an integer", *concurrency);
    return false;
  }
  if (*concurrency < 1 || *concurrency > max) {
    op_throw_out_of_range("options.concurrency", ">= 1 && <= 9007199254740991", *concurrency);
    return false;
  }
  if (!isfinite(*hwm) || floor(*hwm) != *hwm) {
    op_throw_out_of_range("options.highWaterMark", "an integer", *hwm);
    return false;
  }
  if (*hwm < 0 || *hwm > max) {
    op_throw_out_of_range("options.highWaterMark", ">= 0 && <= 9007199254740991", *hwm);
    return false;
  }
  *hwm += *concurrency;
  return true;
}

/* map(fn, options) with fn already checked: +1 generator, or NULL with
 * the error pending. */
static OpMap *op_map_make(ScrStream *s, ScrDyn *fn, ScrDyn *options, int mode) {
  op_sentinels_init();
  if (!op_check_options(options)) return NULL;
  bool ok;
  ScrDyn *signal = op_signal(options, &ok);
  if (!ok) return NULL;
  double concurrency, hwm;
  if (!op_map_options(options, &concurrency, &hwm)) {
    if (signal) scr_dyn_release(signal);
    return NULL;
  }
  OpMap *m = map_new(s, fn, mode, concurrency, hwm, signal);
  if (signal) scr_dyn_release(signal);
  return m;
}

ScrStream *scr_stream_op_map(ScrStream *s, ScrDyn *fn, ScrDyn *options) {
  if (!op_check_fn(fn, "fn", 1)) return NULL;
  OpMap *m = op_map_make(s, fn, options, MODE_MAP);
  return m ? op_from_gen(&m->g) : NULL;
}

ScrStream *scr_stream_op_filter(ScrStream *s, ScrDyn *fn, ScrDyn *options) {
  if (!op_check_fn(fn, "fn", 1)) return NULL;
  OpMap *m = op_map_make(s, fn, options, MODE_FILTER);
  return m ? op_from_gen(&m->g) : NULL;
}

ScrStream *scr_stream_op_flat_map(ScrStream *s, ScrDyn *fn, ScrDyn *options) {
  if (!op_check_fn(fn, "fn", 1)) return NULL;
  OpMap *m = op_map_make(s, fn, options, MODE_MAP);
  if (!m) return NULL;
  OpFlat *f = op_alloc(sizeof *f);
  gen_init(&f->g, &op_flat_body_drop);
  f->g.resume = &flat_resume;
  f->g.ret = &flat_ret;
  f->g.thr = &flat_thr;
  f->values.g = &m->g; /* moves */
  return op_from_gen(&f->g);
}

/* drop(number, options) / take(number, options) */
static ScrStream *op_slice(ScrStream *s, ScrDyn *number, ScrDyn *options, bool take) {
  op_sentinels_init();
  if (!op_check_options(options)) return NULL;
  bool ok;
  ScrDyn *signal = op_signal(options, &ok);
  if (!ok) return NULL;
  /* toIntegerOrInfinity: Number(number), NaN → 0, negative → out of range */
  double n = scr_dyn_number_constructor(number ? number : scr_dyn_undefined());
  if (scr_exc_pending()) {
    if (signal) scr_dyn_release(signal);
    return NULL;
  }
  if (isnan(n)) n = 0;
  if (n < 0) {
    op_throw_out_of_range("number", ">= 0", n);
    if (signal) scr_dyn_release(signal);
    return NULL;
  }
  OpSlice *t = op_alloc(sizeof *t);
  gen_init(&t->g, &op_slice_body_drop);
  t->g.resume = &slice_resume;
  t->g.ret = &slice_ret;
  t->g.thr = &slice_thr;
  t->src.s = scr_stream_retain(s);
  t->signal = signal;
  t->number = n;
  t->take = take;
  return op_from_gen(&t->g);
}

ScrStream *scr_stream_op_drop(ScrStream *s, ScrDyn *number, ScrDyn *options) {
  return op_slice(s, number, options, false);
}

ScrStream *scr_stream_op_take(ScrStream *s, ScrDyn *number, ScrDyn *options) {
  return op_slice(s, number, options, true);
}

/* An async operator whose synchronous prefix threw: the promise rejects. */
static ScrPromise *op_fn_reject_now(OpFn *a) {
  scr_promise_reject_pending(a->p);
  ScrPromise *p = scr_promise_retain(a->p);
  op_unref(a);
  return p;
}

static ScrPromise *op_fn_start(OpFn *a) {
  ScrPromise *p = scr_promise_retain(a->p);
  op_fn_next(a);
  op_unref(a);
  return p;
}

ScrPromise *scr_stream_op_to_array(ScrStream *s, ScrDyn *options) {
  op_sentinels_init();
  OpFn *a = op_fn_new(FN_TO_ARRAY, PK_DYN);
  if (!op_check_options(options)) return op_fn_reject_now(a);
  bool ok;
  a->signal = op_signal(options, &ok);
  if (!ok) return op_fn_reject_now(a);
  a->acc = scr_dyn_new_arr();
  a->src.s = scr_stream_retain(s);
  return op_fn_start(a);
}

/* reduce's pre-aborted path: destroy with the AbortError, wait for the
 * stream to finish, then reject with that error. */
static void op_reduce_aborted_k(void *self, ScrDyn *v) {
  OpFn *a = self;
  if (v) scr_dyn_release(v);
  else scr_exc_clear();
  ScrError *e = scr_stream_errored(a->src.s);
  if (!e) e = op_abort_error(NULL);
  ScrCaught *c = op_take_error(e);
  op_fn_reject(a, c);
  scr_caught_release(c);
}

static void op_noop_listener(ScrClosure *cb, void *err) {
  (void)cb;
  (void)err;
}

ScrPromise *scr_stream_op_reduce(ScrStream *s, ScrDyn *fn, ScrDyn *init, bool has_init,
                                 ScrDyn *options, double kind) {
  op_sentinels_init();
  OpFn *a = op_fn_new(FN_REDUCE, (int)kind);
  if (!op_check_fn(fn, "reducer", 2)) return op_fn_reject_now(a);
  if (!op_check_options(options)) return op_fn_reject_now(a);
  bool ok;
  a->signal = op_signal(options, &ok);
  if (!ok) return op_fn_reject_now(a);
  a->fn = scr_dyn_retain(fn);
  a->has_init = has_init;
  a->acc = scr_dyn_retain(init && has_init ? init : scr_dyn_undefined());
  a->src.s = scr_stream_retain(s);
  if (op_aborted(a->signal)) {
    ScrDyn *reason = op_get(a->signal, "reason");
    ScrError *e = op_abort_error(reason ? reason : scr_dyn_undefined());
    if (reason) scr_dyn_release(reason);
    /* this.once('error', () => {}) */
    ScrStr *name = scr_str_new("error", 5);
    scr_emitter_release(scr_emitter_on((ScrEmitter *)s, name,
                                       scr_closure_new((void *)&op_noop_listener, 0),
                                       scr_ee_inv_fixed1, true, false));
    scr_str_release(name);
    scr_stream_release(scr_stream_destroy(s, e));
    scr_error_release(e);
    ScrPromise *fin = scr_sp_finished(s);
    ScrPromise *p = scr_promise_retain(a->p);
    op_await(fin, &op_reduce_aborted_k, a);
    scr_promise_release(fin);
    op_unref(a);
    return p;
  }
  return op_fn_start(a);
}

/* some/find/every/forEach: the loop over map's generator (filter's for
 * some, find and every). */
static ScrPromise *op_gen_fn(ScrStream *s, ScrDyn *fn, ScrDyn *options, int op, int mode, int kind) {
  op_sentinels_init();
  OpFn *a = op_fn_new(op, kind);
  if (!op_check_fn(fn, "fn", 1)) return op_fn_reject_now(a);
  OpMap *m = op_map_make(s, fn, options, mode);
  if (!m) return op_fn_reject_now(a);
  a->src.g = &m->g; /* moves */
  return op_fn_start(a);
}

ScrPromise *scr_stream_op_some(ScrStream *s, ScrDyn *fn, ScrDyn *options) {
  return op_gen_fn(s, fn, options, FN_SOME, MODE_FILTER, PK_BOOL);
}

ScrPromise *scr_stream_op_find(ScrStream *s, ScrDyn *fn, ScrDyn *options) {
  return op_gen_fn(s, fn, options, FN_FIND, MODE_FILTER, PK_DYN);
}

ScrPromise *scr_stream_op_for_each(ScrStream *s, ScrDyn *fn, ScrDyn *options) {
  return op_gen_fn(s, fn, options, FN_FOR_EACH, MODE_FOREACH, PK_VOID);
}

/* every(fn, options) = !(await some.call(this, async (...args) =>
 * !(await fn(...args)), options)) */
ScrPromise *scr_stream_op_every(ScrStream *s, ScrDyn *fn, ScrDyn *options) {
  op_sentinels_init();
  OpFn *outer = op_fn_new(FN_EVERY, PK_BOOL);
  if (!op_check_fn(fn, "fn", 1)) return op_fn_reject_now(outer);
  ScrPromise *some = op_gen_fn(s, fn, options, FN_EVERY, MODE_EVERY, PK_DYN);
  ScrPromise *p = scr_promise_retain(outer->p);
  op_await(some, &op_every_k, outer);
  scr_promise_release(some);
  op_unref(outer);
  return p;
}
