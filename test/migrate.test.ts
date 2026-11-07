// `docs-lint migrate` against a real consumer: a temp directory reaching this package through a
// node_modules symlink, so the config it writes imports the package by name, as an installed one does.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE = resolve(fileURLToPath(import.meta.url), "../..");
const BIN = join(PACKAGE, "dist/cli.js");
const TARGET = ".markdownlint-cli2.mjs";
const OLD = ".markdownlint-cli2.jsonc";

let root: string;

const write = (name: string, text: string) => {
  writeFileSync(join(root, name), text, "utf8");
};
const docsLint = (...args: string[]) => {
  const done = spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: "utf8" });
  return { status: done.status, stdout: done.stdout, output: done.stdout + done.stderr };
};
const here = (name: string) => existsSync(join(root, name));
const written = () => readFileSync(join(root, TARGET), "utf8");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "docs-lint-migrate-"));
  mkdirSync(join(root, "node_modules"), { recursive: true });
  symlinkSync(PACKAGE, join(root, "node_modules/docs-lint"));
  write("cspell.json", JSON.stringify({ version: "0.2", import: ["docs-lint/cspell"] }));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("without --write it prints the config and changes nothing", () => {
  write(OLD, "{ \"config\": { \"MD041\": false } }\n");
  const { status, stdout } = docsLint("migrate");
  assert.equal(status, 0);
  assert.match(stdout, /withBase\(/);
  assert.equal(here(TARGET), false);
  assert.equal(here(OLD), true);
});

test("only what differs from the base moves, with comments and a trailing comma read", () => {
  write(OLD, `{
    // a comment
    "config": { "default": true, "MD013": false, "MD001": true, "MD041": false, },
    "globs": ["**/*.md"],
    "gitignore": true,
    "noBanner": true,
    "ignores": ["**/node_modules/**", ".vscode/**", "generated/**"],
  }\n`);
  const { status, stdout, output } = docsLint("migrate");
  assert.equal(status, 0, output);
  assert.match(stdout, /MD041: false/);
  assert.match(stdout, /"generated\/\*\*"/);
  for (const dropped of [/MD013/, /MD001/, /default:/, /globs/, /gitignore/, /noBanner/, /node_modules/, /vscode/]) {
    assert.doesNotMatch(stdout, dropped);
  }
  assert.match(output, /turns off MD041/);
});

test("--write replaces the old config, and the command then honors what moved", () => {
  write(OLD, "{ \"config\": { \"MD041\": false }, \"ignores\": [\"generated/**\"], \"gitignore\": true }\n");
  mkdirSync(join(root, "generated"));
  write("generated/skipped.md", "# Title\n\n\n\nToo many blanks above.\n");
  write("a.md", "A file with no heading.\n");
  assert.equal(docsLint("migrate", "--write").status, 0);
  assert.equal(here(OLD), false);
  const { status, output } = docsLint();
  assert.equal(status, 0, output);
  assert.match(output, /1 file\(s\)/);
});

test("markdownlint-cli2's own format that is silent on gitignore keeps reading gitignored files", () => {
  write(OLD, "{}\n");
  const { stdout, output } = docsLint("migrate");
  assert.match(stdout, /gitignore: false/);
  assert.match(output, /keeps reading gitignored files/);
});

test("a rule file is all rules and says nothing about which files are read, in YAML too", () => {
  write(".markdownlint.yaml", "# a comment\nMD041: false\n");
  const { stdout } = docsLint("migrate");
  assert.match(stdout, /MD041: false/);
  assert.doesNotMatch(stdout, /gitignore/);
  rmSync(join(root, ".markdownlint.yaml"));
  write(".markdownlint.json", "{ \"$schema\": \"https://example.com/s.json\", \"MD041\": false }\n");
  const json = docsLint("migrate").stdout;
  assert.match(json, /MD041: false/);
  assert.doesNotMatch(json, /schema/);
});

test("a setting that replaces the base's is kept and named", () => {
  write(".markdownlint.json", "{ \"MD033\": false, \"MD060\": { \"style\": \"compact\" } }\n");
  const { stdout, output } = docsLint("migrate");
  assert.match(stdout, /MD033: false/);
  assert.doesNotMatch(stdout, /MD060/);
  assert.match(output, /replaces the base's MD033/);
});

test("default: false keeps the rules it named, and says what it cannot keep", () => {
  write(".markdownlint.json", "{ \"default\": false, \"MD001\": true }\n");
  const { stdout, output } = docsLint("migrate");
  assert.match(stdout, /default: false/);
  assert.match(stdout, /MD001: true/);
  assert.match(output, /the rules the base names stay on/);
});

test("what cannot be converted exits 2 and changes nothing", () => {
  const refused: [string, string, RegExp][] = [
    [".markdownlint-cli2.cjs", "module.exports = {};\n", /is code/],
    [".markdownlint.json", "{ \"extends\": \"other.json\" }\n", /extends "other\.json"/],
    [OLD, "{ \"config\": ", /cannot read/],
    [OLD, "{ \"notAnOption\": true }\n", /unknown option notAnOption/],
    [OLD, "{ \"ignores\": \"generated/**\" }\n", /ignores must be an array/],
    [".markdownlint.yaml", "- a\n", /does not hold an object/],
  ];
  for (const [name, text, reason] of refused) {
    write(name, text);
    const { status, output } = docsLint("migrate", "--write");
    assert.equal(status, 2, output);
    assert.match(output, reason);
    assert.equal(here(name), true);
    assert.equal(here(TARGET), false);
    rmSync(join(root, name));
  }
});

test("two configs at the root are refused rather than one chosen", () => {
  write(OLD, "{}\n");
  write(".markdownlint.json", "{}\n");
  const { status, output } = docsLint("migrate");
  assert.equal(status, 2);
  assert.match(output, /more than one/);
});

test("an existing target is not overwritten, and the old config stays", () => {
  write(OLD, "{}\n");
  write(TARGET, "// mine\n");
  const { status, output } = docsLint("migrate", "--write");
  assert.equal(status, 2);
  assert.match(output, /not overwritten/);
  assert.equal(written(), "// mine\n");
  assert.equal(here(OLD), true);
  assert.equal(docsLint("migrate").status, 0);
});

test("nothing to migrate exits 0 and writes nothing", () => {
  const { status, output } = docsLint("migrate", "--write");
  assert.equal(status, 0);
  assert.match(output, /no markdownlint config/);
  assert.equal(here(TARGET), false);
});

test("a nested config and a spell config are named and left alone", () => {
  write(OLD, "{}\n");
  mkdirSync(join(root, "sub"));
  write("sub/.markdownlint.json", "{}\n");
  write(".cspell.json", "{}\n");
  const { status, output } = docsLint("migrate", "--write");
  assert.equal(status, 0, output);
  assert.match(output, /still stop a run/);
  assert.match(output, /sub\/\.markdownlint\.json/);
  assert.match(output, /\.cspell\.json/);
  assert.equal(here("sub/.markdownlint.json"), true);
  assert.equal(here(".cspell.json"), true);
});

test("an unknown argument to migrate exits 2", () => {
  assert.equal(docsLint("migrate", "--force").status, 2);
  assert.equal(docsLint("migrate", "--write", "extra").status, 2);
});
