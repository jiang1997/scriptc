import { Counter, describe, nameOf } from "minified-pair";

console.log(describe(3));
console.log(describe(9));
console.log(describe(70));
console.log(nameOf(12), nameOf(-1));
const counter = new Counter();
counter.add(2);
console.log(counter.add(5), counter.count);
