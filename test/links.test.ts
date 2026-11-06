// The link check against a real consumer, set up the way `cli.test.mjs` sets one up.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE = resolve(fileURLToPath(import.meta.url), "../..");
const BIN = join(PACKAGE, "dist/cli.js");

let top: string;
let root: string;

const write = (name: string, text: string) => {
  mkdirSync(dirname(join(root, name)), { recursive: true });
  writeFileSync(join(root, name), text, "utf8");
};
const docsLint = (...args: string[]) => {
  const done = spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: "utf8" });
  return { status: done.status, output: done.stdout + done.stderr };
};
const git = (...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
const page = (body: string) => `# Title\n\n${body}\n`;
const stub = (options: string) =>
  `import { withBase } from "docs-lint/markdownlint";\nexport default withBase(${options});\n`;

const assertFinding = (body: string, pattern: RegExp) => {
  write("a.md", page(body));
  const { status, output } = docsLint("a.md");
  assert.equal(status, 1, output);
  assert.match(output, /docs-lint-links/);
  assert.match(output, pattern);
};
const assertClean = (body: string) => {
  write("a.md", page(body));
  const { status, output } = docsLint("a.md");
  assert.equal(status, 0, output);
};

beforeEach(() => {
  top = realpathSync(mkdtempSync(join(tmpdir(), "docs-lint-links-")));
  root = join(top, "repo");
  mkdirSync(join(root, "node_modules"), { recursive: true });
  symlinkSync(PACKAGE, join(root, "node_modules/docs-lint"));
  write(".markdownlint-cli2.mjs", stub("{}"));
  write(
    "cspell.json",
    JSON.stringify({ version: "0.2", import: ["docs-lint/cspell"] }),
  );
  git("init", "-q");
  write(".gitignore", "node_modules\nsecret/\n");
});

afterEach(() => {
  rmSync(top, { recursive: true, force: true });
});

test("a relative link to a file that exists passes, and one to nothing is a finding", () => {
  write("docs/b.md", page("Target."));
  assertClean("[b](docs/b.md) and ![image](docs/b.md) and [dir](docs/) and [query](docs/b.md?raw=true)");
  assertFinding("[b](docs/missing.md)", /no such file/);
});

test("the reported line counts the frontmatter", () => {
  write("a.md", "---\ntitle: x\n---\n\n# Title\n\n[b](missing.md)\n");
  assert.match(docsLint("a.md").output, /a\.md:7/);
});

test("a link is relative to its file, a leading slash to the repository's root", () => {
  write("docs/a.md", page("[up](../b.md) [root](/b.md)"));
  write("b.md", page("Target."));
  const { status, output } = docsLint("docs/a.md");
  assert.equal(status, 0, output);
  write("docs/c.md", page("[wrong](b.md)"));
  assert.equal(docsLint("docs/c.md").status, 1);
});

test("a reference definition, an image and an HTML attribute are all checked", () => {
  assertFinding("[r][x]\n\n[x]: missing.md", /no such file/);
  assertFinding("![i](missing.png)", /no such file/);
  assertFinding("<img src=\"missing.png\" alt=\"x\">", /no such file/);
});

test("what is not a link is not checked", () => {
  assertClean("`[c](missing.md)` and <!-- [d](missing.md) -->\n\n```text\n[e](missing.md)\n```");
  assertClean("[template]({{skill:name}}.md)");
});

test("an encoded path and a non-ASCII one resolve", () => {
  write("my file.md", page("Target."));
  write("нотатки.md", page("Target."));
  assertClean("[a](my%20file.md) [b](<my file.md>) [c](нотатки.md)");
});

test("the wrong case is a finding, whatever the filesystem says", () => {
  write("README.md", page("Target."));
  assertFinding("[r](readme.md)", /spelled README\.md/);
});

test("a heading in another file is checked by the name MD051 would give it", () => {
  write("b.md", "# Title\n\n## Two Words!\n\n## Twin\n\n## Twin\n\n## Заголовок тут\n\n<a id=\"kept\"></a>\n");
  assertClean(
    "[a](b.md#two-words) [b](b.md#twin-1) [c](b.md#заголовок-тут) [d](b.md#%D0%B7%D0%B0%D0%B3%D0%BE%D0%BB%D0%BE%D0%B2%D0%BE%D0%BA-%D1%82%D1%83%D1%82) [e](b.md#kept) [f](b.md#top) [g](b.md#L10)",
  );
  assertFinding("[a](b.md#no-such-heading)", /no heading for #no-such-heading/);
});

test("a fragment on a file that is not markdown is left alone", () => {
  write("code.py", "pass\n");
  assertClean("[a](code.py#whatever)");
});

test("from a tracked file, a gitignored target is a finding; from an untracked one it is not", () => {
  write("secret/s.md", page("Target."));
  assertClean("[s](secret/s.md)");
  git("add", "a.md");
  const { status, output } = docsLint("a.md");
  assert.equal(status, 1, output);
  assert.match(output, /gitignored/);
});

test("from a tracked file, a target not yet staged passes, because the same commit may add it", () => {
  write("b.md", page("Target."));
  write("a.md", page("[b](b.md)"));
  git("add", "a.md");
  assert.equal(docsLint("a.md").status, 0);
});

test("from a tracked file, a path out of the repository is a finding even if it exists", () => {
  writeFileSync(join(top, "outside.md"), page("Target."));
  assertClean("[o](../outside.md)");
  git("add", "a.md");
  const { status, output } = docsLint("a.md");
  assert.equal(status, 1, output);
  assert.match(output, /leaves the repository/);
});

test("an external link is checked for form and sends nothing", () => {
  assertClean("[a](https://nothing.invalid/x) <mailto:a@example.com> <https://auto.invalid>");
  assertFinding("[a](htp://example.com)", /protocol htp: is not allowed/);
  assertFinding("[a](https://)", /not a valid URL/);
  assertFinding("[a](file:///etc/hosts)", /protocol file: is not allowed/);
});

test("the base denies plain HTTP, except to this machine", () => {
  assertFinding("[a](http://example.com)", /denied by/);
  assertFinding("[a](http://localhost.example.com)", /denied by/);
  assertClean("[a](http://localhost:3000/x) [b](https://localhost) <http://127.0.0.1> [c](http://0.0.0.0:80) [d](http://[::1]:3000)");
});

test("an image's data URL passes, and other data URLs do not", () => {
  assertClean("![a](data:image/png;base64,AAAA)");
  assertFinding("[a](data:text/html,x)", /protocol data: is not allowed/);
});

test("a template's placeholder is not a broken link", () => {
  assertClean("[a]({{x}}.md) [b](${x}/y.md) [c]({x}.md) [d](<url>) [e](https://<host>/x) [f](%X%/y.md) [g](%7B%7Bx%7D%7D.md)");
  assertFinding("[a](<missing file.md>)", /no such file/);
});

test("a destination is read as it means, with its escapes and references resolved", () => {
  write("p(x).md", page("Target."));
  write("a&b.md", page("Target."));
  assertClean("[a](p\\(x\\).md) [b](a&amp;b.md)");
});

test("a repository can allow its sibling, whose links must still resolve", () => {
  writeFileSync(join(top, "outside.md"), page("Target."));
  write(".markdownlint-cli2.mjs", stub("{ config: { \"docs-lint-links\": { allowedRoots: [\"../\"] } } }"));
  write("a.md", page("[o](../outside.md)"));
  git("add", "a.md");
  assert.equal(docsLint("a.md").status, 0);
  write("a.md", page("[o](../missing.md)"));
  const { status, output } = docsLint("a.md");
  assert.equal(status, 1, output);
  assert.match(output, /no such file/);
});

test("a repository can exclude a URL, as a RegExp or a string, past the base's denial", () => {
  write(".markdownlint-cli2.mjs", stub("{ config: { \"docs-lint-links\": { excludedUrls: [/^http:\\/\\/old\\.example/, \"^generated/\"] } } }"));
  assertClean("[a](http://old.example/x) [b](generated/missing.md)");
  assertFinding("[a](http://other.example/x)", /denied by/);
});

test("a repository can deny a URL of its own", () => {
  write(".markdownlint-cli2.mjs", stub("{ config: { \"docs-lint-links\": { deniedUrls: [\"^https://jira\\\\.corp\"] } } }"));
  assertFinding("[a](https://jira.corp/KEY-1)", /denied by/);
  assertClean("[a](https://example.com)");
});

test("a source excluded from links keeps the rest of the lint", () => {
  write(".markdownlint-cli2.mjs", stub("{ config: { \"docs-lint-links\": { excludedSources: [\"records/**\"] } } }"));
  write("records/r.md", page("[dead](missing.md)"));
  assert.equal(docsLint("records/r.md").status, 0);
  write("records/r.md", page("[dead](missing.md)\n\n\n"));
  const { status, output } = docsLint("records/r.md");
  assert.equal(status, 1);
  assert.match(output, /MD012/);
  assert.doesNotMatch(output, /docs-lint-links/);
});

test("a comment disables the rule for one line, and a repository can turn it off", () => {
  assertClean("<!-- markdownlint-disable-next-line docs-lint-links -->\n[dead](missing.md)");
  write(".markdownlint-cli2.mjs", stub("{ config: { \"docs-lint-links\": false } }"));
  assertClean("[dead](missing.md)");
});

test("withBase keeps the link rule beside a repository's own custom rules", () => {
  write(
    ".markdownlint-cli2.mjs",
    stub("{ customRules: [{ names: [\"own\"], description: \"own\", tags: [\"custom\"], parser: \"none\", function: () => {} }] }"),
  );
  assertFinding("[dead](missing.md)", /no such file/);
});

test("--staged sees a rename break a link in a file it does not touch", () => {
  write("b.md", page("Target."));
  write("a.md", page("[b](b.md)"));
  git("add", ".");
  assert.equal(docsLint("--staged").status, 0);
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "base");
  renameSync(join(root, "b.md"), join(root, "c.md"));
  git("add", "b.md", "c.md");
  const { status, output } = docsLint("--staged");
  assert.equal(status, 1, output);
  assert.match(output, /a\.md:3 error docs-lint-links .*\[no such file\]/);
});

test("--staged sees a deletion of a file that is not markdown", () => {
  write("i.png", "x");
  write("a.md", page("![i](i.png)"));
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "base");
  git("rm", "-q", "i.png");
  const { status, output } = docsLint("--staged");
  assert.equal(status, 1, output);
  assert.match(output, /a\.md:3 error docs-lint-links/);
});

test("--staged sees a renamed heading break a link from another file", () => {
  write("b.md", page("## Old"));
  write("a.md", page("[b](b.md#old)"));
  git("add", ".");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "base");
  write("b.md", page("## New"));
  git("add", "b.md");
  const { status, output } = docsLint("--staged");
  assert.equal(status, 1, output);
  assert.match(output, /a\.md:3 error docs-lint-links .*\[no heading for #old\]/);
});

test("--staged does not answer for a dead link unrelated to the commit", () => {
  write("a.md", page("[dead](missing.md)"));
  write("b.md", page("Target."));
  git("add", "a.md");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "base", "--no-verify");
  git("add", "b.md");
  const { status, output } = docsLint("--staged");
  assert.equal(status, 0, output);
});

test("--staged does not read a gitignored file for links into the commit", () => {
  write("b.md", page("Target."));
  git("add", "b.md");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "base");
  write("secret/s.md", page("[b](../b.md)"));
  git("rm", "-q", "b.md");
  assert.equal(docsLint("--staged").status, 0);
});

test("each repository in one run is asked about its own files", () => {
  git("add", ".gitignore");
  write("adir/x.md", page("Target."));
  git("add", "adir/x.md");
  write("nested/bdir/y.md", page("Target."));
  write("nested/z.md", page("[b](bdir/)"));
  spawnSync("git", ["init", "-q"], { cwd: join(root, "nested") });
  spawnSync("git", ["add", "."], { cwd: join(root, "nested") });
  write("a.md", page("[a](adir/)"));
  git("add", "a.md");
  const { status, output } = docsLint("a.md", "nested/z.md");
  assert.equal(status, 0, output);
});

test("git failing is reported rather than skipping the tracked-file checks", () => {
  write("a.md", page("[b](b.md)"));
  write("b.md", page("Target."));
  git("add", "a.md");
  const done = spawnSync(process.execPath, [BIN, "a.md"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GIT_DIR: join(top, "no-such-dir") },
  });
  assert.equal(done.status, 2, done.stdout + done.stderr);
  assert.match(done.stdout + done.stderr, /git cannot list/);
});

test("a repository's RegExp with the g flag gives the same answer every time", () => {
  write(".markdownlint-cli2.mjs", stub("{ config: { \"docs-lint-links\": { excludedUrls: [/^missing/g] } } }"));
  assertClean("[a](missing-a.md) [b](missing-b.md) [c](missing-c.md)");
});

test("a misspelled option is refused, with the names that exist", () => {
  write("a.md", page("Body."));
  const cases: [string, RegExp][] = [
    ["{ ignore: [\"x\"] }", /unknown option ignore; known: config, ignores/],
    ["{ config: { \"docs-lint-links\": { excludeUrls: [] } } }", /unknown option excludeUrls of docs-lint-links; known: excludedUrls/],
    ["{ config: { \"docs-lint-link\": false } }", /unknown option docs-lint-link; known: docs-lint-links/],
    ["{ config: { \"docs-lint-links\": { excludedUrls: \"x\" } } }", /excludedUrls of docs-lint-links must be an array/],
  ];
  for (const [options, pattern] of cases) {
    write(".markdownlint-cli2.mjs", stub(options));
    const { status, output } = docsLint("a.md");
    assert.equal(status, 2, output);
    assert.match(output, pattern);
  }
});

test("the options markdownlint-cli2 knows and the rule's own pass", () => {
  write("a.md", page("Body."));
  write(
    ".markdownlint-cli2.mjs",
    stub("{ noInlineConfig: false, showFound: false, config: { MD013: false, \"docs-lint-links\": { excludedUrls: [], deniedUrls: [], excludedSources: [], allowedRoots: [] } } }"),
  );
  const { status, output } = docsLint("a.md");
  assert.equal(status, 0, output);
});
