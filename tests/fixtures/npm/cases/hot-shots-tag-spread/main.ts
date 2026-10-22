// hot-shots (compiled from scriptc's built-in shim) with tag objects built
// by spreading a record whose non-string fields later properties override,
// valid against hot-shots' { [key: string]: string } tag type. The keys
// keep the spread's order. The program also defines an Error subclass with
// a `name` getter, which must not keep the shim's own error logging from
// compiling.
import { StatsD } from "hot-shots";

interface FailureTags {
  phase: string;
  httpStatus: number;
  retried: boolean;
  region: string;
}

const mock = new StatsD({ mock: true, prefix: "bc.", globalTags: { env: "test" } });
const tags: FailureTags = { phase: "fetch", httpStatus: 503, retried: true, region: "east" };
for (let attempt = 1; attempt <= 2; attempt++) {
  mock.increment("prefetch_attempt_failed", {
    ...tags,
    attempt: String(attempt),
    httpStatus: String(tags.httpStatus),
    retried: tags.retried ? "yes" : "no",
  });
}
const base: Record<string, string> = { team: "core", owner: "infra" };
mock.gauge("queue", 4, { ...base, owner: "builds", shard: "7" });
mock.distribution("size", 12, { ...base });
console.log(mock.mockBuffer);

class TaggedError extends Error {
  get name(): string {
    return "TaggedError";
  }
}
try {
  throw new TaggedError("tagged");
} catch (error) {
  console.log((error as Error).name, (error as Error).message);
}
mock.close(() => console.log("closed"));
