"use strict";
// Writes the members of counted.cjs's export through this module's own
// require of it: a computed key, Object.assign, and a helper the value is
// passed to.
const counted = require("./counted.cjs");
counted["total"] = 2;
Object.assign(counted, { label: "two" });
function rename(target) {
  target.unit = "piece";
}
rename(counted);
