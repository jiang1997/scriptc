// `Object.fromEntries(...) as T` keeps the object only when the entries'
// values are scalars or checked-dynamic values. Native arrays and records
// in the entries would be copied, severing their identity, so the
// assertion keeps the exact-shape fence (corpus 6467 covers the cases that
// lower).
type Scores = { a: number[]; b: number[] };
const shared = [10];
const scores = Object.fromEntries([
  ["a", shared],
  ["b", shared],
]) as Scores;
scores.a.push(11);
console.log(shared.length, scores.b.length);
