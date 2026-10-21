'use strict';
// ToString of objects whose toString or valueOf comes from the object or
// its prototype chain: template literals, join, String(), concatenation,
// Array.prototype.toString and the default sort order call it, as in Node.
function RefNum(num) { this.num = num; }
RefNum.prototype.toString = function () { return "R" + this.num; };
function Inherit() {}
Inherit.prototype = Object.create(RefNum.prototype);
Inherit.prototype.num = 9;

const r = new RefNum(5);
const deep = new Inherit();
const own = { toString() { return "own"; } };
const viaValueOf = { valueOf() { return 42; } };
const both = { toString() { return "ts"; }, valueOf() { return 7; } };
const plain = {};
const m = new Map([[1, r]]);

console.log(`${r}`, `${deep}`, `${own}`, `${viaValueOf}`, `${both}`, `${plain}`);
console.log(`${m.get(1) || 0}`, `${m.get(2) || 0}`, r * 2);
console.log([r, deep, own, both, plain].join("|"));
console.log([r, own].toString(), String([r, own]), `${[r, own]}`);
console.log([[r, [own]], null, undefined, deep].join(";"));
console.log(String(r), r + "", own + "", both + "", viaValueOf + "", "x".concat(r));
console.log([new RefNum(3), new RefNum(1), own, new RefNum(2)].sort().join(","));

// A toString returning an object falls back to valueOf; a null prototype
// leaves neither, which throws.
const objectResult = { toString() { return {}; }, valueOf() { return "vo"; } };
console.log(`${objectResult}`, [objectResult].join());
const bare = Object.create(null);
try { console.log(`${bare}`); } catch (e) { console.log(e.name, e.message); }
try { console.log([bare].join()); } catch (e) { console.log(e.name, e.message); }

// An exception from toString propagates out of each conversion.
const thrower = { toString() { throw new Error("boom"); } };
try { console.log(`${thrower}`); } catch (e) { console.log("template", e.message); }
try { console.log([thrower].join()); } catch (e) { console.log("join", e.message); }
try { console.log(String([thrower])); } catch (e) { console.log("String", e.message); }
try { console.log([new RefNum(1), thrower].sort()); } catch (e) { console.log("sort", e.message); }
