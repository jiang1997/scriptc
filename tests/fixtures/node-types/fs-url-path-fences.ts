import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";

const url = new URL("file:///tmp/node-types-url-fences");
// existsSync answers false for a URL it cannot convert.
console.log(existsSync(url));
// The fs.promises functions reject for a URL they cannot convert.
void readFile(url, "utf8");
void stat(url);
