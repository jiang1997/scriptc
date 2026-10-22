// Copies of object literals that write the same keys in different orders:
// spreads, spreads with other keys before and after, rest bindings,
// Object.assign and structuredClone keep each value's own order.
const a = { id: 1, name: "a", ok: true };
const b = { name: "b", ok: false, id: 2 };
const c = { ok: true, id: 3, name: "c" };
for (const value of [a, b, c]) {
  const copy = { ...value };
  const changed = { ...value, id: 10 };
  const after = { ...value, extra: "e" };
  const before = { first: 0, ...value };
  const { name, ...rest } = value;
  const assigned = Object.assign({}, value);
  const cloned = structuredClone(value);
  console.log(JSON.stringify(copy), JSON.stringify(changed));
  console.log(JSON.stringify(after), Object.keys(before).join(","));
  console.log(name, JSON.stringify(rest), Object.keys(rest).join(","));
  console.log(JSON.stringify(assigned), JSON.stringify(cloned));
}
// Keys after a spread that the spread value may lack: a key the value has
// keeps its place, and a key it lacks goes after the value's keys.
type Options = { id: number; label?: string; size?: number; tag?: string };
const options: Options[] = [
  { id: 1, size: 2 },
  { size: 3, id: 2 },
  { label: "c", id: 3, tag: "t" },
  { tag: "u", size: 4, id: 4 },
];
for (const value of options) {
  const merged = { ...value, tag: "x", label: "y", done: true };
  console.log(Object.keys(merged).join(","), JSON.stringify(merged));
}
