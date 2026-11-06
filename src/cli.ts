#!/usr/bin/env node
/**
 * Lint a repository's markdown: markdownlint with the link check, the hard-wrap check, the spell check.
 *
 * The lint and the hard-wrap check exit 1. The spell check only warns: a proper name, a domain or a
 * verbatim read of an external source is flagged as readily as a misspelling, and a word list cannot
 * be kept ahead of every one of them. A tool that could not run at all exits 2, because a check that
 * checked nothing must not read the same as a clean one.
 */

import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { BaseOptions } from "./config/markdownlint.ts";

const USAGE = `usage: docs-lint [--fix] [--staged] [file.md...]

  (no arguments)  every markdown file in the tree, without what is gitignored
  file.md...      those files
  --staged        the markdown staged in this commit, and tracked links into what it changes, for a pre-commit hook
  --fix           apply what can be fixed safely: hard wraps and the lint rules that only change layout`;

const MARKDOWNLINT_CONFIG = ".markdownlint-cli2.mjs";
const SPELLING_CONFIG = "cspell.json";
const DEFAULT_TIMEOUT_SECONDS = 600;
// Under every platform's limit on a command line that this package is tested on, with room for the rest.
const MAX_ARGUMENT_BYTES = 200_000;
const MAX_FIX_PASSES = 5;

const require = createRequire(import.meta.url);

function fail(message: string): never {
  console.error(`docs-lint: ${message}`);
  process.exit(2);
}

/** Exit once stdout has drained: `process.exit` drops whatever a pipe has not taken yet. */
async function finish(code: number): Promise<never> {
  await new Promise((drained) => process.stdout.write("", drained));
  process.exit(code);
}

// Node exits 1 on an uncaught error, which a hook would read as findings.
process.on("uncaughtException", (error) => fail(error.message));

// Before anything below is loaded: on an older Node, a dependency's syntax error exits 1, and a tool's
// complaint on stdout reads as spelling findings.
const required = require("../package.json").engines.node.replace(/^>=/, "");
const atLeast = (have: string, need: string): boolean => {
  const [haveMajor = 0, haveMinor = 0] = have.split(".").map(Number);
  const [needMajor = 0, needMinor = 0] = need.split(".").map(Number);
  return haveMajor > needMajor || (haveMajor === needMajor && haveMinor >= needMinor);
};
if (!atLeast(process.versions.node, required)) fail(`needs Node ${required} or later, and this is ${process.versions.node}`);

const { isRegularFile, listFiles, rivalConfigs } = await import("./files.ts");
const { LINKS_RULE, linksInto } = await import("./links.ts");
const { firstWrappedLine, globToRegExp, ignoredBy, reflowFiles } = await import("./reflow.ts");

const timeoutMs = 1000 * (Number(process.env.DOCS_LINT_TIMEOUT) || DEFAULT_TIMEOUT_SECONDS);

/**
 * A tool's executable, resolved from this package. A repository may pin another version of the same
 * tool, and npm then nests the one this package asked for: `npx` would run the repository's.
 */
function toolBin(name: string): string {
  let dir = dirname(require.resolve(name));
  for (;;) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      const { name: found, bin } = JSON.parse(readFileSync(manifest, "utf8"));
      if (found === name) return resolve(dir, typeof bin === "string" ? bin : bin[name]);
    }
    dir = dirname(dir);
  }
}

function runTool(name: string, args: string[], options: Partial<SpawnSyncOptionsWithStringEncoding> = {}): SpawnSyncReturns<string> {
  const done = spawnSync(process.execPath, [toolBin(name), ...args], {
    encoding: "utf8",
    maxBuffer: Infinity,
    timeout: timeoutMs,
    ...options,
  });
  if ((done.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") fail(`${name} did not finish in ${timeoutMs / 1000} s; DOCS_LINT_TIMEOUT sets the limit`);
  return done;
}

/** `files` in portions a command line can hold. */
function portions(files: string[]): string[][] {
  const result: string[][] = [[]];
  let bytes = 0;
  for (const file of files) {
    bytes += Buffer.byteLength(file) + 2;
    if (bytes > MAX_ARGUMENT_BYTES && result.at(-1)!.length) {
      result.push([]);
      bytes = Buffer.byteLength(file) + 2;
    }
    result.at(-1)!.push(file);
  }
  return result;
}

/** Markdownlint-cli2 over `files`. It exits 1 on findings and above that on a failure. */
function runLint(files: string[], { fix = false } = {}): { found: boolean; output: string } {
  const env = fix ? { ...process.env, DOCS_LINT_FIX_PASS: "1" } : process.env;
  const results = portions(files).map((portion) =>
    // A leading colon makes the path literal: `app/(group)/x.md` and `!x.md` would otherwise be patterns,
    // match nothing, and pass.
    runTool("markdownlint-cli2", ["--no-globs", ...portion.map((file) => `:${file}`), ...(fix ? ["--fix"] : [])], { env }),
  );
  const failed = results.find(({ status }) => status === null || status > 1);
  if (failed) fail(`markdownlint-cli2 failed\n${failed.stdout ?? ""}${failed.stderr ?? ""}`);
  return {
    found: results.some(({ status }) => status === 1),
    output: results.map(({ stdout, stderr }) => stdout + stderr).join(""),
  };
}

function gitNames(command: string, ...args: string[]): string[] {
  const done = spawnSync("git", [command, "-z", ...args], { encoding: "utf8", maxBuffer: Infinity });
  if (done.status !== 0) fail(`cannot read the staged files: ${done.stderr.trim()}`);
  return done.stdout.split("\0").filter(Boolean);
}

function isUtf8(file: string): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(file));
    return true;
  } catch {
    return false;
  }
}

function parse(args: string[]): { fix: boolean; staged: boolean; files: string[] } {
  const options: { fix: boolean; staged: boolean; files: string[] } = { fix: false, staged: false, files: [] };
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

const options = parse(process.argv.slice(2));

for (const config of [MARKDOWNLINT_CONFIG, SPELLING_CONFIG]) {
  if (!existsSync(config)) fail(`no ${config} here. Run from the repository root; the README shows the file.`);
}

const loaded = (await import(pathToFileURL(resolve(MARKDOWNLINT_CONFIG)).href) as { default: BaseOptions }).default;
const ignored = ignoredBy(process.cwd(), loaded.ignores ?? []);
const globs = (loaded.globs ?? ["**/*.md"]).map(globToRegExp);
const isMarkdown = (file: string): boolean => globs.some((glob) => glob.test(file.replace(/^\.\//, "")));

const tree = listFiles(process.cwd(), { gitignore: loaded.gitignore !== false, ignored });

const rivals = rivalConfigs(process.cwd(), tree);
if (rivals.length) {
  fail(`these configs would replace ${MARKDOWNLINT_CONFIG} or ${SPELLING_CONFIG} and turn checks off without a word. Remove them, or exclude them in ignores:\n  ${rivals.join("\n  ")}`);
}

function namedFiles() {
  for (const file of options.files) {
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) continue; // see lib/files.mjs
    if (!stat?.isFile()) fail(`not a file: ${file}`);
    if (!isMarkdown(file)) fail(`not markdown: ${file}`);
  }
  return options.files.filter((file) => isRegularFile(file) && !ignored(file));
}

function stagedFiles() {
  const prefix = spawnSync("git", ["rev-parse", "--show-prefix"], { encoding: "utf8" });
  if (prefix.status !== 0) fail("--staged needs a git repository");
  // Git names staged paths from its root, and everything here reads from the working directory.
  if (prefix.stdout.trim()) fail("run --staged from the repository root");
  return gitNames("diff", "--cached", "--name-only", "--diff-filter=ACMR").filter(
    (file) => isMarkdown(file) && !ignored(file) && isRegularFile(file),
  );
}

/** Tracked links, outside the staged files, into what this commit changes. Reports them; how many. */
function reportLinksIntoStaged(staged: string[]): number {
  // With renames off, a renamed file reads as its old path deleted, which is the path links still name.
  const deleted = gitNames("diff", "--cached", "--name-only", "--no-renames", "--diff-filter=D");
  const others = gitNames("ls-files").filter(
    (file) => isMarkdown(file) && !staged.includes(file) && !ignored(file) && isRegularFile(file),
  );
  const findings = linksInto(others, [...staged, ...deleted], loaded.config?.[LINKS_RULE] ?? {});
  for (const finding of findings) console.log(finding);
  return findings.length;
}

function warnOnPartialStaging(staged: string[]): void {
  const unstaged = new Set(gitNames("diff", "--name-only"));
  for (const file of staged.filter((name) => unstaged.has(name))) {
    console.error(`docs-lint: ${file} has unstaged changes; the working tree was checked, not what the commit holds`);
  }
}

let files;
if (options.staged) files = stagedFiles();
else if (options.files.length) files = namedFiles();
else files = tree.filter(isMarkdown);

const dangling = options.staged ? reportLinksIntoStaged(files) : 0;
if (options.staged) warnOnPartialStaging(files);
if (!files.length) {
  if (!options.staged && !options.files.length) console.error("docs-lint: no markdown files here");
  await finish(dangling ? 1 : 0);
}

const notUtf8 = files.filter((file) => !isUtf8(file));
if (notUtf8.length) {
  fail(`not UTF-8, so it cannot be read safely and a fix would destroy its bytes. Convert it, or exclude it in ignores:\n  ${notUtf8.join("\n  ")}`);
}

// A fold can change what the lint sees and a lint fix can expose another, so the two take turns until
// the text stops moving. What the fix leaves is then reported by the same check a plain run does.
if (options.fix) {
  const read = () => files.map((file) => readFileSync(file, "utf8"));
  const original = read();
  let before = original;
  for (let pass = 0; pass < MAX_FIX_PASSES; pass += 1) {
    reflowFiles(files, { check: false, ignored });
    runLint(files, { fix: true });
    const after = read();
    const moved = after.some((text, index) => text !== before[index]);
    before = after;
    if (!moved) break;
  }
  console.log(`docs-lint: --fix changed ${before.filter((text, index) => text !== original[index]).length} file(s)`);
}

const lint = runLint(files);
process.stdout.write(lint.output);
const countFindings = (matches: (line: string) => boolean): number => lint.output.split("\n").filter((line) => / error /.test(line) && matches(line)).length;
const linkFindings = countFindings((line) => line.includes(` error ${LINKS_RULE}`));
const lintFindings = countFindings((line) => !line.includes(` error ${LINKS_RULE}`));

const wrapped = reflowFiles(files, { check: true, ignored });
for (const file of wrapped) {
  console.log(`${file}:${firstWrappedLine(readFileSync(file, "utf8"))} hard-wrapped paragraph; docs-lint --fix unwraps it`);
}

// Cspell exits 1 on findings and on a config it could not load alike. Only findings print to stdout,
// so a failure with nothing there is the tool failing, not a warning. It takes the list on stdin, where
// no character in a name can make it a glob and no length can overflow a command line.
const spelling = runTool("cspell", ["--no-progress", "--no-summary", "--no-must-find-files", "--dot", "--file-list", "stdin"], {
  input: files.join("\n"),
  stdio: ["pipe", "pipe", "inherit"],
});
process.stdout.write(spelling.stdout ?? "");
if (spelling.status === null || (spelling.status !== 0 && !spelling.stdout)) await finish(2);
const spellingWarnings = (spelling.stdout ?? "").split("\n").filter(Boolean).length;

console.log(
  `docs-lint: ${files.length} file(s): ${lintFindings} lint, ${linkFindings + dangling} links, ${wrapped.length} hard-wrapped, ${spellingWarnings} spelling warnings`,
);
await finish(lint.found || wrapped.length || dangling ? 1 : 0);
