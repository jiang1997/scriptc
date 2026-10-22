/* The piped-stdin differential case table — event-loop.test.ts's cases,
 * extracted so the Linux lane runs the IDENTICAL fixtures with the
 * IDENTICAL stdin scripts through its container (docker exec -i carries
 * the pipe; EOF propagates when the harness closes its end). Fixture
 * programs live in tests/fixtures/event-loop. */

export interface StdinScript {
  /** Writes performed in order; `delayMs` waits BEFORE the write. */
  writes: { delayMs: number; data: string }[];
  /** Close the write end after the writes (false = hold the pipe open
   * until the child exits on its own — the timeout paths). */
  end: boolean;
}

export interface EventLoopCase {
  title: string;
  fixture: string;
  script: StdinScript;
}

export const eventLoopCases: EventLoopCase[] = [
  {
    title: "stdio values: paused reads consume buffered input",
    fixture: "stdio-read.mjs",
    script: { writes: [{ delayMs: 30, data: "hello" }], end: true },
  },
  {
    title: "stdio values: pause preserves data until resume",
    fixture: "stdio-pause-resume.mjs",
    script: { writes: [{ delayMs: 0, data: "hello" }], end: true },
  },
  {
    title: "stdio values: paused input releases the event loop",
    fixture: "stdio-paused-exit.mjs",
    script: { writes: [], end: false },
  },
  {
    title: "stdio values: 'readable' drains with read(), then fires once more at EOF",
    fixture: "stdio-readable.mjs",
    script: {
      writes: [
        { delayMs: 0, data: "alpha " },
        { delayMs: 60, data: "beta\n" },
      ],
      end: true,
    },
  },
  {
    title: "stdio values: 'readable' with read(size) holds a partial tail until EOF",
    fixture: "stdio-readable-size.mjs",
    script: { writes: [{ delayMs: 0, data: "abcdefghij" }], end: true },
  },
  {
    title: "stdio values: 'readable' on an immediately ended pipe",
    fixture: "stdio-readable.mjs",
    script: { writes: [], end: true },
  },
  {
    title: "for-await: process.stdin yields Buffers",
    fixture: "stdin-for-await-buffers.mjs",
    script: {
      writes: [
        { delayMs: 0, data: ">ONE\nACGT\n" },
        { delayMs: 40, data: ">TWO\nTTGA\n" },
      ],
      end: true,
    },
  },
  {
    title: "read-all: one instant write, then EOF",
    fixture: "stdin-read-all.ts",
    script: { writes: [{ delayMs: 0, data: "hello stdin\nsecond line\n" }], end: true },
  },
  {
    title: "read-all: chunked writes with delays, then EOF",
    fixture: "stdin-read-all.ts",
    script: {
      writes: [
        { delayMs: 0, data: "alpha " },
        { delayMs: 60, data: "beta " },
        { delayMs: 60, data: "gamma\n" },
      ],
      end: true,
    },
  },
  {
    title: "read-all: immediate EOF, no data",
    fixture: "stdin-read-all.ts",
    script: { writes: [], end: true },
  },
  {
    title: "race-timeout: instant data wins the race",
    fixture: "stdin-race-timeout.ts",
    script: { writes: [{ delayMs: 0, data: "abc" }], end: true },
  },
  {
    title: "race-timeout: open pipe with no data — timeout wins, destroy releases the loop",
    fixture: "stdin-race-timeout.ts",
    script: { writes: [], end: false },
  },
  {
    title: "race-timeout: immediate EOF — 'end' wins",
    fixture: "stdin-race-timeout.ts",
    script: { writes: [], end: true },
  },
  // node:readline — the question/close slice (SEMANTICS.md; the close
  // emit is SYNCHRONOUS, so the prompt shape's close-listener resolve
  // wins over the answer's, exactly Node).
  // node:readline cases assert only chunking-INDEPENDENT outcomes (a
  // burst consumed by a closing interface takes its surplus with it, so
  // where chunk boundaries fall — a load-dependent race — must not decide
  // the expected output; the stdin unit's own contract).
  {
    title: "readline: prompt answered, second prompt sees EOF",
    fixture: "rl-question.ts",
    script: { writes: [{ delayMs: 0, data: "yes\n" }], end: true },
  },
  {
    title: "readline: EOF before any line — close wins, the partial discards",
    fixture: "rl-question.ts",
    script: { writes: [{ delayMs: 20, data: "partial" }], end: true },
  },
  {
    title: "readline: sequential questions on one interface, CRLF terminators, surplus drops",
    fixture: "rl-lines.ts",
    script: { writes: [{ delayMs: 20, data: "one one\r\ntwo\nthree unheard\n" }], end: true },
  },
  {
    title: "readline: immediate EOF closes the interface",
    fixture: "rl-lines.ts",
    script: { writes: [], end: true },
  },
];
