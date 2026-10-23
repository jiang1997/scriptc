// Records built in JavaScript in another key order than the TypeScript
// literals of the same type: a replacement method installed through a
// computed key, and a function stored on the global object, read through a
// typed view, that calls a callback inside its options record.
export function install(target, name) {
  target[name] = () => ({ a: 1, b: 2 });
}

globalThis.__eachRow = function (options) {
  options.visit({ x: 5, y: 6 });
};
