/**
 * Which files a run reads. One list goes to all three checks, so they cannot disagree about a file, and
 * each path reaches a tool literally, so no character in a name can make it a glob.
 *
 * A symlink is never followed. What it points at is linted as itself if it is in the repository, and is
 * not this repository's to rewrite if it is not; following one is also how a loop hangs a run.
 */

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export type IsIgnored = (name: string) => boolean;

const OWN_CONFIGS = new Set([".markdownlint-cli2.mjs", "cspell.json"]);
const LINT_CONFIG = /^\.markdownlint(?:-cli2)?\.(?:jsonc?|ya?ml|cjs|mjs)$/;
const SPELLING_CONFIG = /^\.?cspell(?:\.config)?\.(?:jsonc?|ya?ml|js|cjs|mjs|toml)$/i;

export const isLintConfig = (name: string): boolean => LINT_CONFIG.test(basename(name));

export const isRegularFile = (path: string): boolean => lstatSync(path, { throwIfNoEntry: false })?.isFile() ?? false;

export function isUtf8(file: string): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(file));
    return true;
  } catch {
    return false;
  }
}

/** Every file under `dir`, stopping at symlinks and at another repository nested inside this one. */
function walk(dir: string, ignored: IsIgnored): string[] {
  const found: string[] = [];
  const visit = (at: string): void => {
    for (const entry of readdirSync(join(dir, at), { withFileTypes: true })) {
      const name = at ? `${at}/${entry.name}` : entry.name;
      if (entry.name === ".git" || entry.name === "node_modules" || ignored(name)) continue;
      if (entry.isFile()) found.push(name);
      else if (entry.isDirectory() && !existsSync(join(dir, name, ".git"))) visit(name);
    }
  };
  visit("");
  return found.sort();
}

/**
 * The files of the tree at `dir`. In a repository, git's list, which leaves out what is gitignored and
 * what a nested repository holds. With `gitignore` off, or outside any repository, a walk of the tree.
 */
export function listFiles(dir: string, { gitignore, ignored }: { gitignore: boolean; ignored: IsIgnored }): string[] {
  if (!gitignore) return walk(dir, ignored);
  const done = spawnSync("git", ["-C", dir, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    encoding: "utf8",
    maxBuffer: Infinity,
  });
  if (done.status === 0) {
    return done.stdout.split("\0").filter((name) => name && !ignored(name) && isRegularFile(join(dir, name)));
  }
  if (existsSync(join(dir, ".git"))) throw new Error(`git cannot list this repository: ${done.error?.message ?? done.stderr.trim()}`);
  return walk(dir, ignored);
}

/**
 * Configs that would quietly replace this package's. Markdownlint-cli2 and cspell each take the first
 * they find, and markdownlint-cli2 applies a nested one to its directory, so a leftover turns checks off
 * with nothing to show for it.
 */
export function rivalConfigs(dir: string, files: string[]): string[] {
  const atRoot = readdirSync(dir).filter(
    (name) => !OWN_CONFIGS.has(name) && (LINT_CONFIG.test(name) || SPELLING_CONFIG.test(name)),
  );
  const nested = files.filter((name) => name.includes("/") && isLintConfig(name));
  return [...atRoot, ...nested];
}
