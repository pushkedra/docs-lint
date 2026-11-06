/** Running the tools this package wraps. */

import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fail } from "./output.ts";

const DEFAULT_TIMEOUT_SECONDS = 600;

const require = createRequire(import.meta.url);

/**
 * A tool's executable, resolved from this package. A repository may pin another version of the same
 * tool, and npm then nests the one this package asked for: `npx` would run the repository's.
 */
function toolBin(name: string): string {
  let dir = dirname(require.resolve(name));
  for (;;) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      const { name: found, bin } = JSON.parse(readFileSync(manifest, "utf8")) as {
        name: string;
        bin: string | Record<string, string>;
      };
      if (found === name) return resolve(dir, typeof bin === "string" ? bin : bin[name]);
    }
    dir = dirname(dir);
  }
}

type RunOptions = Partial<SpawnSyncOptionsWithStringEncoding>;

/** `script` under this Node, in a process of its own, reported as `name` if it runs out of time. */
export function runScript(
  name: string,
  script: string,
  args: string[],
  options: RunOptions = {},
): SpawnSyncReturns<string> {
  const timeoutMs = 1000 * (Number(process.env.DOCS_LINT_TIMEOUT) || DEFAULT_TIMEOUT_SECONDS);
  const done = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    maxBuffer: Infinity,
    timeout: timeoutMs,
    ...options,
  });
  if (done.error && "code" in done.error && done.error.code === "ETIMEDOUT") {
    fail(`${name} did not finish in ${timeoutMs / 1000} s; DOCS_LINT_TIMEOUT sets the limit`);
  }
  return done;
}

export function runTool(name: string, args: string[], options: RunOptions = {}): SpawnSyncReturns<string> {
  return runScript(name, toolBin(name), args, options);
}
