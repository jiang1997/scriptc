import { globSync } from "glob";

console.log(globSync("glob13-*.ts", { cwd: import.meta.dirname }));
