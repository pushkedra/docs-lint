/** One run: which files, the fix if asked for, then the three checks and their totals. */

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { formatFinding, runLint } from "./checks/lint.ts";
import { runSpelling } from "./checks/spelling.ts";
import { firstWrappedLine, reflowFiles } from "./checks/wrap.ts";
import type { BaseOptions } from "./config/markdownlint.ts";
import { isRegularFile, isUtf8, listFiles, rivalConfigs } from "./files.ts";
import { globToRegExp, ignoredBy } from "./globs.ts";
import { fail, finish } from "./output.ts";
import { LINKS_RULE } from "./rules/links/rule.ts";
import { assertAtRepositoryRoot, linkFindingsIntoStaged, stagedFiles, warnOnPartialStaging } from "./staged.ts";

export interface RunOptions {
  fix: boolean;
  staged: boolean;
  files: string[];
}

const MARKDOWNLINT_CONFIG = ".markdownlint-cli2.mjs";
const SPELLING_CONFIG = "cspell.json";
const MAX_FIX_PASSES = 5;
// How markdownlint reports a rule that crashed: as an ordinary finding, which would read as exit 1.
const RULE_EXCEPTION = "This rule threw an exception";

function namedFiles(
  files: string[],
  isMarkdown: (file: string) => boolean,
  ignored: (file: string) => boolean,
): string[] {
  for (const file of files) {
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) continue; // never read, as `files.ts` says
    if (!stat?.isFile()) fail(`not a file: ${file}`);
    if (!isMarkdown(file)) fail(`not markdown: ${file}`);
  }
  // A skip is not a failure, since a hook may pass any file, but with no findings silence would read as clean.
  return files.filter((file) => {
    const reason = !isRegularFile(file) ? "a symlink is not read" : ignored(file) ? "the config excludes it" : null;
    if (reason) console.error(`docs-lint: skipped ${file}: ${reason}`);
    return !reason;
  });
}

/**
 * A fold can change what the lint sees and a lint fix can expose another, so the two take turns until
 * the text stops moving.
 */
function fix(files: string[], ignored: (file: string) => boolean): void {
  const read = (): string[] => files.map((file) => readFileSync(file, "utf8"));
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

export async function run(options: RunOptions): Promise<void> {
  for (const config of [MARKDOWNLINT_CONFIG, SPELLING_CONFIG]) {
    if (!existsSync(config)) fail(`no ${config} here. Run from the repository root; the README shows the file.`);
  }

  const imported = await import(pathToFileURL(resolve(MARKDOWNLINT_CONFIG)).href) as { default?: BaseOptions };
  const loaded = imported.default;
  // Without the base there are no rules and no link check, and the run would report a clean tree.
  if (!loaded?.customRules?.some((rule) => (rule as { names?: string[] }).names?.includes(LINKS_RULE))) {
    fail(`${MARKDOWNLINT_CONFIG} has to export withBase(...) as its default, or the checks are off. The README shows the file.`);
  }
  const allGlobs = loaded.globs ?? ["**/*.md"];
  // Files reach the tools by name, past their globbing, so a negated glob has to act as an exclusion here.
  const negated = allGlobs.filter((glob) => glob.startsWith("!")).map((glob) => glob.slice(1));
  const globs = allGlobs.filter((glob) => !glob.startsWith("!")).map(globToRegExp);
  const ignored = ignoredBy(process.cwd(), [...loaded.ignores ?? [], ...negated]);
  const isMarkdown = (file: string): boolean => globs.some((glob) => glob.test(file.replace(/^\.\//, "")));

  const tree = listFiles(process.cwd(), { gitignore: loaded.gitignore !== false, ignored });

  const rivals = rivalConfigs(process.cwd(), tree);
  if (rivals.length) {
    fail(`these configs would replace ${MARKDOWNLINT_CONFIG} or ${SPELLING_CONFIG} and turn checks off without a word. `
      + `Remove them; a nested one may be excluded in ignores instead:\n  ${rivals.join("\n  ")}`);
  }

  let files: string[];
  if (options.staged) {
    assertAtRepositoryRoot();
    files = stagedFiles(isMarkdown, ignored);
  } else if (options.files.length) {
    files = namedFiles(options.files, isMarkdown, ignored);
  } else {
    files = tree.filter(isMarkdown);
  }

  const dangling = options.staged
    ? linkFindingsIntoStaged(files, isMarkdown, ignored, loaded.config?.[LINKS_RULE] ?? {})
    : [];
  for (const finding of dangling) console.log(formatFinding(finding));
  if (options.staged) warnOnPartialStaging(files);
  if (!files.length) {
    if (!options.staged && !options.files.length) console.error("docs-lint: no markdown files here");
    await finish(dangling.length ? 1 : 0);
  }

  const notUtf8 = files.filter((file) => !isUtf8(file));
  if (notUtf8.length) {
    fail("not UTF-8, so it cannot be read safely and a fix would destroy its bytes. "
      + `Convert it, or exclude it in ignores:\n  ${notUtf8.join("\n  ")}`);
  }

  if (options.fix) fix(files, ignored);

  const lint = runLint(files);
  const crashed = lint.findings.find(({ errorDetail }) => errorDetail?.startsWith(RULE_EXCEPTION));
  if (crashed) fail(formatFinding(crashed));
  for (const finding of lint.findings) console.log(formatFinding(finding));
  if (lint.unparsed) process.stdout.write(lint.unparsed);
  const errors = lint.findings.filter(({ severity }) => severity === "error");
  const linkFindings = errors.filter(({ ruleNames }) => ruleNames.includes(LINKS_RULE)).length + dangling.length;
  const lintFindings = errors.filter(({ ruleNames }) => !ruleNames.includes(LINKS_RULE)).length;

  const wrapped = reflowFiles(files, { check: true, ignored });
  for (const file of wrapped) {
    const line = firstWrappedLine(readFileSync(file, "utf8")) ?? 1;
    console.log(`${file}:${line} hard-wrapped paragraph; docs-lint --fix unwraps it`);
  }

  const spelling = runSpelling(files);
  process.stdout.write(spelling.output);
  if (spelling.failed) await finish(2);

  console.log(`docs-lint: ${files.length} file(s): ${lintFindings} lint, ${linkFindings} links, `
    + `${wrapped.length} hard-wrapped, ${spelling.warnings} spelling warnings`);
  await finish(lint.found || wrapped.length || dangling.length ? 1 : 0);
}
