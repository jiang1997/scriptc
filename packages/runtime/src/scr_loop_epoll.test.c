#undef NDEBUG
#define _GNU_SOURCE 1
#include "scr_platform.h"
#include <assert.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

/* The epoll poller alone: timers live in a deadline heap behind one
 * timerfd, so arming, re-arming and cancelling many keys must still
 * deliver each armed key exactly once, in deadline order, after its
 * deadline, and never a cancelled key. */

enum { KEYS = 2000 };

static double now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1e6;
}

static int keys[KEYS];
static double deadline[KEYS];
static int state[KEYS]; /* 0 unarmed/cancelled, 1 armed, 2 fired */

/* Wait for the poller fd, then drain; returns the events drained. */
static int pump(ScrPoller *p, ScrPollerEvent *evs, int max, int wait_ms) {
  struct pollfd pfd = {.fd = scrp_poller_fd(p), .events = POLLIN};
  (void)poll(&pfd, 1, wait_ms);
  return scrp_drain(p, evs, max);
}

int main(void) {
  ScrPoller *p = scrp_poller_new();
  assert(p != NULL);
  srand(7);
  double start = now_ms();
  /* Each deadline counts from its own arm call: arming takes time, here
   * stretched by a pause halfway, and the poller reads the clock at each
   * call. */
  for (int i = 0; i < KEYS; i++) {
    if (i == KEYS / 2)
      for (double until = now_ms() + 3; now_ms() < until;) {
      }
    double ms = 5 + rand() % 120;
    double t = now_ms();
    assert(scrp_timer_arm(p, &keys[i], ms, &keys[i]));
    deadline[i] = t + ms;
    state[i] = 1;
  }
  /* re-arm a third later and earlier, cancel a third (the heap and the key
   * table move entries on every one of these) */
  for (int i = 0; i < KEYS; i++) {
    if (i % 3 == 0) {
      double ms = 1 + rand() % 150;
      double t = now_ms();
      assert(scrp_timer_arm(p, &keys[i], ms, &keys[i]));
      deadline[i] = t + ms;
    } else if (i % 3 == 1) {
      scrp_timer_cancel(p, &keys[i]);
      state[i] = 0;
    }
  }
  scrp_timer_cancel(p, &keys[1]); /* cancel of a cancelled key: no-op */
  /* an fd delivers alongside the timers */
  int fds[2];
  assert(pipe(fds) == 0);
  static int pipe_tag;
  assert(scrp_watch_read(p, fds[0], &pipe_tag, true));
  assert(write(fds[1], "x", 1) == 1);
  int armed = 0;
  for (int i = 0; i < KEYS; i++) armed += state[i] == 1;
  int fired = 0, piped = 0;
  double last = 0;
  ScrPollerEvent evs[16]; /* small batches leave due timers for the next drain */
  while (fired < armed) {
    int n = pump(p, evs, 16, 1000);
    for (int e = 0; e < n; e++) {
      if (evs[e].udata == &pipe_tag) {
        assert(evs[e].events == SCRP_READABLE);
        char c;
        assert(read(fds[0], &c, 1) == 1);
        piped++;
        continue;
      }
      assert(evs[e].events == SCRP_TIMER);
      int i = (int)((int *)evs[e].udata - keys);
      assert(i >= 0 && i < KEYS);
      assert(state[i] == 1);
      double t = now_ms();
      assert(t + 1.0 >= deadline[i]); /* never early (timerfd rounding aside) */
      assert(deadline[i] + 1.0 >= last); /* deadline order */
      if (deadline[i] > last) last = deadline[i];
      state[i] = 2;
      fired++;
    }
    assert(now_ms() - start < 10000);
  }
  assert(piped == 1);
  /* nothing else fires: the cancelled keys stay quiet */
  assert(pump(p, evs, 16, 200) == 0);
  /* a key fires again after re-arming once it fired; 0 ms fires at once */
  assert(scrp_timer_arm(p, &keys[0], 0, &keys[0]));
  int n = pump(p, evs, 16, 1000);
  assert(n == 1 && evs[0].udata == &keys[0] && evs[0].events == SCRP_TIMER);
  scrp_forget(p, fds[0]);
  close(fds[0]);
  close(fds[1]);
  scrp_poller_free(p);
  puts("epoll timers fire once each, in deadline order, never when cancelled");
  return 0;
}
