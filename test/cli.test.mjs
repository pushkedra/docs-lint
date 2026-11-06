// The command against a real consumer: a temp directory reaching this package through a
// node_modules symlink, so its configs import the package by name, as an installed one does.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE = resolve(fileURLToPath(import.meta.url), "../..");
const BIN = join(PACKAGE, "bin/docs-lint.mjs");

let root;

const write = (name, text) => writeFileSync(join(root, name), text, "utf8");
const docsLint = (...args) => {
  const done = spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: "utf8" });
  return { status: done.status, output: done.stdout + done.stderr };
};
const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });

const cspell = (extra = {}) =>
  JSON.stringify({
    version: "0.2",
    import: ["docs-lint/cspell"],
    dictionaryDefinitions: [{ name: "project-words", path: "./project-words.txt", addWords: true }],
    dictionaries: ["project-words"],
    ...extra,
  });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "docs-lint-"));
  mkdirSync(join(root, "node_modules"), { recursive: true });
  symlinkSync(PACKAGE, join(root, "node_modules/docs-lint"));
  write(
    ".markdownlint-cli2.mjs",
    'import { withBase } from "docs-lint/markdownlint";\nexport default withBase({ ignores: ["generated/**"] });\n',
  );
  write("cspell.json", cspell());
  write("project-words.txt", "");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test("a clean tree exits 0", () => {
  write("a.md", "# Title\n\nA clean paragraph.\n");
  assert.equal(docsLint().status, 0);
});

test("a lint finding exits 1", () => {
  write("a.md", "# Title\n\n\n\nToo many blanks above.\n");
  const { status, output } = docsLint();
  assert.equal(status, 1);
  assert.match(output, /MD012/);
});

test("a hard-wrapped paragraph exits 1 and names the file", () => {
  write("a.md", "# Title\n\nOne line\nof a paragraph.\n");
  const { status, output } = docsLint();
  assert.equal(status, 1);
  assert.match(output, /a\.md:3 hard-wrapped/);
});

test("--fix unwraps, repairs what the lint can, and then passes", () => {
  write("a.md", "# Title\n\n\n\nOne line\nof a paragraph.\n");
  assert.equal(docsLint("--fix").status, 0);
  assert.equal(readFileSync(join(root, "a.md"), "utf8"), "# Title\n\nOne line of a paragraph.\n");
});

test("a spelling finding warns and exits 0", () => {
  write("a.md", "# Title\n\nA wrod in prose.\n");
  const { status, output } = docsLint();
  assert.equal(status, 0);
  assert.match(output, /Unknown word \(wrod\)/);
  assert.match(output, /warnings/);
});

test("a British form is forbidden, and a repository can allow one word of them", () => {
  write("a.md", "# Title\n\nThe licence and the honour.\n");
  assert.match(docsLint().output, /Forbidden word \(licence\)/);
  write("cspell.json", cspell({ ignoreWords: ["licence"] }));
  const { output } = docsLint();
  assert.doesNotMatch(output, /licence/);
  assert.match(output, /Forbidden word \(honour\)/);
});

test("the shared word list and the repository's word list both apply", () => {
  write("project-words.txt", "zorblax\n");
  write("a.md", "# Title\n\nThe frontmatter of zorblax.\n");
  assert.doesNotMatch(docsLint().output, /Unknown word/);
});

test("a code span quoting a backtick does not turn the check inside out", () => {
  write("a.md", "# Title\n\nA `` ` `` then wrod in prose and `shlex` in code.\n");
  const { output } = docsLint();
  assert.match(output, /Unknown word \(wrod\)/);
  assert.doesNotMatch(output, /shlex/);
});

test("a spell config that cannot load exits 2 rather than reading as a warning", () => {
  write("a.md", "# Title\n\nA clean paragraph.\n");
  write("cspell.json", JSON.stringify({ version: "0.2", import: ["./missing.json"] }));
  assert.equal(docsLint().status, 2);
  assert.equal(docsLint("a.md").status, 2);
  git("init", "-q");
  git("add", "a.md");
  assert.equal(docsLint("--staged").status, 2);
});

test("a repository's exclusion reaches all three checks, in a full run and for a named file", () => {
  mkdirSync(join(root, "generated"));
  write("generated/a.md", "no heading\nand a wrap\n\n\n\nwrod\n");
  write("cspell.json", cspell({ ignorePaths: ["generated/**"] }));
  write("b.md", "# Title\n\nA clean paragraph.\n");
  for (const args of [[], ["generated/a.md", "b.md"]]) {
    const { status, output } = docsLint(...args);
    assert.equal(status, 0, output);
    assert.doesNotMatch(output, /wrod|MD0|generated\/a\.md/);
  }
});

test("a base exclusion holds from node_modules", () => {
  mkdirSync(join(root, ".idea"), { recursive: true });
  write(".idea/a.md", "no heading\nand a wrap wrod\n");
  const { status, output } = docsLint();
  assert.equal(status, 0, output);
  assert.doesNotMatch(output, /wrod/);
});

test("--staged sees only what is staged, and nothing staged passes", () => {
  git("init", "-q");
  write("staged.md", "# Title\n\n\n\nFinding here.\n");
  write("other.md", "no heading\n");
  assert.equal(docsLint("--staged").status, 0);
  git("add", "staged.md");
  const { status, output } = docsLint("--staged");
  assert.equal(status, 1);
  assert.match(output, /staged\.md/);
  assert.doesNotMatch(output, /other\.md/);
});

test("a file that is not there, or is not a file, exits 2 before anything runs", () => {
  mkdirSync(join(root, "dir"));
  for (const name of ["nope.md", "dir"]) {
    const { status, output } = docsLint(name);
    assert.equal(status, 2, output);
    assert.match(output, new RegExp(`not a file: ${name}`));
  }
});

test("a config that cannot load exits 2 rather than reading as findings", () => {
  write("a.md", "# Title\n\nA clean paragraph.\n");
  write(".markdownlint-cli2.mjs", "export default {{{\n");
  assert.equal(docsLint("a.md").status, 2);
});

test("--staged from below the repository's root exits 2 and says so", () => {
  git("init", "-q");
  mkdirSync(join(root, "pkg"));
  write("pkg/p.md", "# Title\n");
  git("add", "pkg/p.md");
  const done = spawnSync(process.execPath, [BIN, "--staged"], { cwd: join(root, "pkg"), encoding: "utf8" });
  assert.equal(done.status, 2);
});

test("a named file that is not markdown is refused rather than folded", () => {
  write("notes.txt", "one\ntwo\n");
  const { status, output } = docsLint("--fix", "notes.txt");
  assert.equal(status, 2);
  assert.match(output, /not markdown: notes\.txt/);
  assert.equal(readFileSync(join(root, "notes.txt"), "utf8"), "one\ntwo\n");
});

test("a leftover config is refused, because it would silently win", () => {
  write("a.md", "# Title\n\nA clean paragraph.\n");
  for (const name of [".markdownlint-cli2.jsonc", ".markdownlint.json", ".cspell.json"]) {
    write(name, "{}\n");
    const { status, output } = docsLint();
    assert.equal(status, 2, output);
    assert.match(output, new RegExp(name.replaceAll(".", "\\.")));
    rmSync(join(root, name));
  }
  mkdirSync(join(root, "sub"));
  write("sub/.markdownlint.json", "{}\n");
  assert.equal(docsLint().status, 2);
  rmSync(join(root, "sub/.markdownlint.json"));
  assert.equal(docsLint().status, 0);
});

test("a file with special characters in its name is really checked", () => {
  git("init", "-q");
  for (const name of ["(group)/x.md", "#y.md", "!z.md", "[a] b.md", "-dash.md"]) {
    const dir = name.includes("/") ? join(root, "(group)") : root;
    mkdirSync(dir, { recursive: true });
    write(name, "# Title\n\n[dead](missing.md)\n");
    git("add", "--", name);
    const staged = docsLint("--staged");
    assert.equal(staged.status, 1, staged.output);
    assert.match(staged.output, /docs-lint-links/);
    git("rm", "-q", "--cached", "--", name);
    rmSync(join(root, name));
  }
});

test("--fix refuses a file that is not UTF-8 and leaves it byte for byte", () => {
  const bytes = Buffer.from("# T\n\nCaf\xe9 one\ntwo\n", "latin1");
  writeFileSync(join(root, "a.md"), bytes);
  const { status, output } = docsLint("--fix");
  assert.equal(status, 2);
  assert.match(output, /not UTF-8/);
  assert.deepEqual(readFileSync(join(root, "a.md")), bytes);
});

test("--fix leaves alone what only an author can decide, and the check still reports it", () => {
  const text = "# Title\n\n1. A\n\nText\n\n2. B\n\n- [x]\n\n`a `b` c`\n\n[unused]: https://example.com\n";
  write("a.md", text);
  const { status, output } = docsLint("--fix");
  assert.equal(status, 1, output);
  assert.equal(readFileSync(join(root, "a.md"), "utf8"), text);
  assert.match(output, /MD029|MD053/);
});

test("--fix keeps a tab in code and reaches a fixed point in one run", () => {
  write("a.md", "# Title\n\n\n\nOne\ntwo\n\n```make\n\tgo build\n```\n");
  assert.equal(docsLint("--fix").status, 0);
  assert.equal(readFileSync(join(root, "a.md"), "utf8"), "# Title\n\nOne two\n\n```make\n\tgo build\n```\n");
  assert.match(docsLint("--fix").output, /changed 0 file/);
});

test("a symlink is not read: not a file, not a directory, not a loop, and --fix cannot write through it", () => {
  const outside = mkdtempSync(join(tmpdir(), "docs-lint-outside-"));
  try {
    const wrapped = "# Far\n\nOne\ntwo\n";
    writeFileSync(join(outside, "far.md"), wrapped);
    symlinkSync(outside, join(root, "dir"));
    symlinkSync(join(outside, "far.md"), join(root, "file.md"));
    symlinkSync(root, join(root, "loop"));
    write("a.md", "# Title\n\nA clean paragraph.\n");
    const { status, output } = docsLint("--fix");
    assert.equal(status, 0, output);
    assert.equal(readFileSync(join(outside, "far.md"), "utf8"), wrapped);
    assert.match(output, /1 file\(s\)/);
    assert.equal(docsLint("file.md").status, 0);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("markdown under .git is never read", () => {
  git("init", "-q");
  write(".git/x.md", "no heading\nand a wrap wrod\n");
  write("a.md", "# Title\n\nA clean paragraph.\n");
  const { status, output } = docsLint();
  assert.equal(status, 0, output);
  assert.doesNotMatch(output, /wrod|MD041/);
});

test("the spell check reads a dot directory in a full run", () => {
  mkdirSync(join(root, ".claude/skills"), { recursive: true });
  write(".claude/skills/a.md", "# Title\n\nA wrod in prose.\n");
  assert.match(docsLint().output, /Unknown word \(wrod\)/);
});

test("a gitignored file is left out, and gitignore: false brings it back", () => {
  git("init", "-q");
  write(".gitignore", "node_modules\nlocal/\n");
  mkdirSync(join(root, "local"));
  write("local/a.md", "no heading\nand a wrap\n");
  write("b.md", "# Title\n\nA clean paragraph.\n");
  assert.equal(docsLint().status, 0);
  assert.equal(docsLint("--fix").status, 0);
  assert.equal(readFileSync(join(root, "local/a.md"), "utf8"), "no heading\nand a wrap\n");
  assert.equal(docsLint("local/a.md").status, 1);
  write(
    ".markdownlint-cli2.mjs",
    'import { withBase } from "docs-lint/markdownlint";\nexport default withBase({ gitignore: false });\n',
  );
  const { status, output } = docsLint();
  assert.equal(status, 1);
  assert.match(output, /local\/a\.md/);
});

test("a repository's globs narrow all three checks", () => {
  mkdirSync(join(root, "docs"));
  write("docs/a.md", "# Title\n\nA clean paragraph.\n");
  write("b.md", "no heading\nand a wrap wrod\n");
  write(
    ".markdownlint-cli2.mjs",
    'import { withBase } from "docs-lint/markdownlint";\nexport default withBase({ globs: ["docs/**/*.md"] });\n',
  );
  const { status, output } = docsLint();
  assert.equal(status, 0, output);
  assert.doesNotMatch(output, /wrod/);
});

test("a tool that does not finish in time exits 2 and says so", () => {
  write("a.md", "# Title\n\nA clean paragraph.\n");
  const done = spawnSync(process.execPath, [BIN], { cwd: root, encoding: "utf8", env: { ...process.env, DOCS_LINT_TIMEOUT: "0.001" } });
  assert.equal(done.status, 2);
  assert.match(done.stderr, /did not finish/);
});

test("many staged files with long names do not overflow a command line", () => {
  git("init", "-q");
  const dir = "d".repeat(120);
  mkdirSync(join(root, dir));
  for (let i = 0; i < 8000; i += 1) writeFileSync(join(root, dir, `${"f".repeat(100)}${i}.md`), "# T\n\nBody.\n");
  git("add", "-A");
  const { status, output } = docsLint("--staged");
  assert.equal(status, 0, output);
  assert.match(output, /8000 file\(s\)/);
});

test("--staged warns when a staged file has unstaged changes", () => {
  git("init", "-q");
  write("a.md", "# Title\n\nStaged.\n");
  git("add", "a.md");
  write("a.md", "# Title\n\nChanged after.\n");
  assert.match(docsLint("--staged").output, /a\.md has unstaged changes/);
});

test("--staged outside a repository says so", () => {
  const { status, output } = docsLint("--staged");
  assert.equal(status, 2);
  assert.match(output, /needs a git repository/);
  assert.ok(output.split("\n").length < 5);
});

test("the last line totals each check, and spelling is only a warning there", () => {
  git("init", "-q");
  write("a.md", "# Title\n\n[dead](missing.md) and a wrod\nwrapped.\n\n\nMore.\n");
  const { status, output } = docsLint();
  assert.equal(status, 1);
  assert.match(output.trim().split("\n").at(-1), /1 file\(s\): 1 lint, 1 links, 1 hard-wrapped, 1 spelling warnings/);
});

test("a staged symlink and a file staged then removed are skipped", () => {
  git("init", "-q");
  write("a.md", "# Title\n\nA clean paragraph.\n");
  symlinkSync("a.md", join(root, "b.md"));
  symlinkSync("nowhere.md", join(root, "c.md"));
  write("d.md", "# Title\n\nBody.\n");
  git("add", "-A");
  renameSync(join(root, "d.md"), join(root, "e.md"));
  const { status, output } = docsLint("--staged");
  assert.equal(status, 0, output);
});

test("a config that is absent exits 2 and says so", () => {
  rmSync(join(root, "cspell.json"));
  const { status, output } = docsLint();
  assert.equal(status, 2);
  assert.match(output, /no cspell\.json/);
});

test("--staged refuses --fix and files; an unknown option refuses", () => {
  assert.equal(docsLint("--staged", "--fix").status, 2);
  assert.equal(docsLint("--staged", "a.md").status, 2);
  assert.equal(docsLint("--nope").status, 2);
});
