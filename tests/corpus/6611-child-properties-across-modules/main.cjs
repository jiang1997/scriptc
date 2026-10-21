"use strict";
// Properties a JavaScript module adds to a child it did not spawn: reads,
// accessor calls on the child, a write to a getter-only accessor, and the
// replaced kill. definer.cjs replaces kill through Reflect.defineProperty
// and writes a getter-only property with a long name.
const patched = require("./patcher.cjs");
const definer = require("./definer.cjs");
const child = patched();
console.log(child.label);
child.label = "x";
console.log(child.stored, child.same);
try {
  child.same = 1;
} catch (e) {
  console.log(e instanceof TypeError, e.message);
}
child.on("close", (code) => {
  console.log("close", code, child.killedBy);
});
child.kill("SIGTERM");
child.on("exit", () => definer());
