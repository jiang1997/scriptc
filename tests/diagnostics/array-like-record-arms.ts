// An array value in a union whose only arm that accepts it is an
// array-like object type (`{ length: number; [index: number]: number }`)
// has no conversion into that arm. Both the literal and the binding are
// refused at the flow; they do not compile into a run-time TypeError.
type Slot = string[] | { length: number; [index: number]: number };

function describe(s: Slot): string {
  if (Array.isArray(s)) return "array " + s.length;
  return "object " + s.length;
}

const literal: Slot = [3, 4, 5];
console.log(describe(literal));

const numbers = [3, 4, 5];
const bound: Slot = numbers;
console.log(describe(bound));

const strings: Slot = ["a", "b"];
console.log(describe(strings));
