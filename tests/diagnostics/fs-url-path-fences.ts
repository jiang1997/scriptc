// URL paths whose conversion would run in a different order than Node's.
import * as fs from "node:fs";

const url = new URL("file:///tmp/fs-url-path-fences");
const encoding: BufferEncoding = process.argv.length > 9 ? "latin1" : "utf8";
const recursive = process.argv.length > 9;

// Node validates the string source before converting the URL destination.
fs.copyFileSync("/tmp/source", url);
// Node validates the options before the path.
console.log(fs.readFileSync(url, encoding));
fs.mkdirSync(url, { recursive });
// A literal's members are lowered one by one, so they cannot be evaluated
// ahead of the conversion as one value.
console.log(fs.statSync(url, { throwIfNoEntry: process.argv.length > 9 }));
