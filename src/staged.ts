/** What `--staged` asks git, and the links into what a commit changes. */

import { spawnSync } from "node:child_process";
import type { LinkOptions } from "./config/markdownlint.ts";
import { isRegularFile } from "./files.ts";
import { fail } from "./output.ts";
import { type FileFinding, linksInto } from "./rules/links/rule.ts";

function gitNames(command: string, ...args: string[]): string[] {
  const done = spawnSync("git", [command, "-z", ...args], { encoding: "utf8", maxBuffer: Infinity });
  if (done.status !== 0) fail(`cannot read the staged files: ${done.stderr.trim()}`);
  return done.stdout.split("\0").filter(Boolean);
}

export function assertAtRepositoryRoot(): void {
  const prefix = spawnSync("git", ["rev-parse", "--show-prefix"], { encoding: "utf8" });
  if (prefix.status !== 0) fail("--staged needs a git repository");
  // Git names staged paths from its root, and everything here reads from the working directory.
  if (prefix.stdout.trim()) fail("run --staged from the repository root");
}

export function stagedFiles(isMarkdown: (file: string) => boolean, ignored: (file: string) => boolean): string[] {
  return gitNames("diff", "--cached", "--name-only", "--diff-filter=ACMR").filter(
    (file) => isMarkdown(file) && !ignored(file) && isRegularFile(file),
  );
}

/** Tracked links, outside the staged files, into what this commit changes. */
export function linkFindingsIntoStaged(
  staged: string[],
  isMarkdown: (file: string) => boolean,
  ignored: (file: string) => boolean,
  config: LinkOptions | false,
): FileFinding[] {
  // With renames off, a renamed file reads as its old path deleted, which is the path links still name.
  const deleted = gitNames("diff", "--cached", "--name-only", "--no-renames", "--diff-filter=D");
  const others = gitNames("ls-files").filter(
    (file) => isMarkdown(file) && !staged.includes(file) && !ignored(file) && isRegularFile(file),
  );
  return linksInto(others, [...staged, ...deleted], config);
}

export function warnOnPartialStaging(staged: string[]): void {
  const unstaged = new Set(gitNames("diff", "--name-only"));
  for (const file of staged.filter((name) => unstaged.has(name))) {
    console.error(`docs-lint: ${file} has unstaged changes; the working tree was checked, not what the commit holds`);
  }
}
