// The types as a consumer meets them: the built declarations reached through the package's `exports`,
// from a config written the way the README shows.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE = resolve(fileURLToPath(import.meta.url), "../..");
const TSC = join(PACKAGE, "node_modules/typescript/bin/tsc");

let root;

const check = (options) => {
  writeFileSync(
    join(root, "config.mjs"),
    `// @ts-check\nimport { withBase } from "docs-lint/markdownlint";\nexport default withBase(${options});\n`,
  );
  const done = spawnSync(
    process.execPath,
    [TSC, "--noEmit", "--allowJs", "--checkJs", "--module", "nodenext", "--target", "es2023", "--skipLibCheck", "--types", "node", "--typeRoots", join(PACKAGE, "node_modules/@types"), "config.mjs"],
    { cwd: root, encoding: "utf8" },
  );
  return { status: done.status, output: done.stdout + done.stderr };
};

before(() => {
  const build = spawnSync(process.execPath, [TSC, "--project", "tsconfig.types.json"], { cwd: PACKAGE, encoding: "utf8" });
  assert.equal(build.status, 0, build.stdout);
  root = mkdtempSync(join(tmpdir(), "docs-lint-types-"));
  mkdirSync(join(root, "node_modules"));
  symlinkSync(PACKAGE, join(root, "node_modules/docs-lint"));
});

after(() => rmSync(root, { recursive: true, force: true }));

test("a correct config type-checks", () => {
  const { status, output } = check(
    '{ ignores: ["x/**"], gitignore: false, config: { MD013: false, "docs-lint-links": { excludedUrls: [/^a/, "^b"], allowedRoots: ["../s"] } } }',
  );
  assert.equal(status, 0, output);
});

test("a misspelled option of withBase is a type error", () => {
  const { status, output } = check('{ ignore: ["x/**"] }');
  assert.notEqual(status, 0);
  assert.match(output, /ignore/);
});

test("a misspelled option of the link rule is a type error", () => {
  const { status, output } = check('{ config: { "docs-lint-links": { excludeUrls: [] } } }');
  assert.notEqual(status, 0);
  assert.match(output, /excludeUrls/);
});
