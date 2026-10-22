"use strict";
const { spawn } = require("child_process");
module.exports = function start() {
  return spawn(process.execPath, ["-e", "process.stdout.write('ok')"]);
};
