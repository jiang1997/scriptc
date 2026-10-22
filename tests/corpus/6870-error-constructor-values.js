// The error constructors as values in JavaScript: an error's `constructor`
// is the same function the global names, whose name, length, typeof and
// String() are Node's, for errors the program throws, errors the runtime
// throws, and errors read back from catch bindings and containers.
function describe(label, error) {
  const ctor = error.constructor;
  console.log(label, error.name, error.constructor.name, typeof ctor, ctor.length, String(ctor));
}

describe('Error', new Error('e'));
describe('TypeError', new TypeError('t'));
describe('RangeError', new RangeError('r'));
describe('SyntaxError', new SyntaxError('s'));
describe('ReferenceError', new ReferenceError('f'));
describe('EvalError', new EvalError('v'));
describe('URIError', new URIError('u'));
describe('AggregateError', new AggregateError([], 'a'));

const thrown = [
  () => JSON.parse('{'),
  () => {
    const holder = JSON.parse('{"value":null}');
    return holder.value.missing;
  },
  () => new Array(-1),
  () => decodeURIComponent('%'),
  () => {
    throw new TypeError('own');
  },
];
const constructors = { SyntaxError, TypeError, RangeError, URIError };
const caught = [];
for (const run of thrown) {
  try {
    run();
  } catch (error) {
    caught.push(error);
    console.log('caught', error.constructor.name, error.constructor === constructors[error.name]);
  }
}

const byName = new Map();
for (const error of caught) byName.set(error.constructor.name, (byName.get(error.constructor.name) ?? 0) + 1);
console.log('kinds', JSON.stringify([...byName]));

console.log('identity', new TypeError('x').constructor === TypeError, new RangeError('x').constructor === TypeError);
console.log('globals', Error.name, TypeError.length, AggregateError.length, typeof RangeError, String(SyntaxError));

const renamed = new TypeError('x');
renamed.name = 'Custom';
console.log('renamed', renamed.name, renamed.constructor.name);

class ParseFailure extends SyntaxError {}
const failure = new ParseFailure('p');
console.log('subclass', failure.name, failure.constructor.name, failure instanceof SyntaxError);
