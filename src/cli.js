#!/usr/bin/env node
import { run } from './main.js';

run(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
