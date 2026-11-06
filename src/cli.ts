#!/usr/bin/env node
/**
 * The command: its arguments and its exit codes. `runner.ts` holds what a run does.
 *
 * The lint and the hard-wrap check exit 1. The spell check only warns: a proper name, a domain or a
 * verbatim read of an external source is flagged as readily as a misspelling, and a word list cannot
 * be kept ahead of every one of them. A tool that could not run at all exits 2, because a check that
 * checked nothing must not read the same as a clean one.
 */

import { createRequire } from "node:module";
import { fail } from "./output.ts";
import type { RunOptions } from "./runner.ts";

const USAGE = `usage: docs-lint [--fix] [--staged] [file.md...]

  (no arguments)  every markdown file in the tree, without what is gitignored
  file.md...      those files
  --staged        the markdown staged in this commit, and tracked links into what it changes, for a pre-commit hook
  --fix           apply what can be fixed safely: hard wraps and the lint rules that only change layout`;

// Node exits 1 on an uncaught error, which a hook would read as findings.
process.on("uncaughtException", (error) => fail(error.message));

// Before anything below is loaded: on an older Node, a dependency's syntax error exits 1, and a tool's
// complaint on stdout reads as spelling findings.
const require = createRequire(import.meta.url);
const { engines } = require("../package.json") as { engines: { node: string } };
const required = engines.node.replace(/^>=/, "");
const atLeast = (have: string, need: string): boolean => {
  const [haveMajor = 0, haveMinor = 0] = have.split(".").map(Number);
  const [needMajor = 0, needMinor = 0] = need.split(".").map(Number);
  return haveMajor > needMajor || (haveMajor === needMajor && haveMinor >= needMinor);
};
if (!atLeast(process.versions.node, required)) {
  fail(`needs Node ${required} or later, and this is ${process.versions.node}`);
}

function parse(args: string[]): RunOptions {
  const options: RunOptions = { fix: false, staged: false, files: [] };
  for (const arg of args) {
    if (arg === "--fix") options.fix = true;
    else if (arg === "--staged") options.staged = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(USAGE);
      process.exit(0);
    } else if (arg.startsWith("-")) {
      fail(`unknown option ${arg}\n\n${USAGE}`);
    } else options.files.push(arg);
  }
  // A fix lands in the working tree while the commit takes the index, so the two together would pass
  // a hook on text the commit does not hold.
  if (options.staged && (options.fix || options.files.length)) fail(`--staged takes no --fix and no files\n\n${USAGE}`);
  return options;
}

const { run } = await import("./runner.ts");
await run(parse(process.argv.slice(2)));
