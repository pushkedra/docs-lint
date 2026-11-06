/** What the link rule asks git. */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { cached } from "./cache.ts";

export interface GitListing {
  tracked: Set<string>;
  visible: Set<string>;
  dirs: Set<string>;
}

/**
 * The nearest directory above `path` holding `.git`, walked as spelled. Asking git would resolve
 * symlinks first, and a symlinked directory belongs to the repository it is linked from.
 */
export function rootOf(path: string): string | null {
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dir === dirname(dir)) return null;
  }
}

const gitFiles = (root: string, ...args: string[]): Set<string> => {
  const done = spawnSync("git", ["-C", root, "ls-files", "-z", ...args], { encoding: "utf8", maxBuffer: Infinity });
  // Without this answer the tracked-file checks cannot run, which must not read as a clean file.
  if (done.status !== 0) throw new Error(`git cannot list ${root}: ${done.error?.message ?? done.stderr.trim()}`);
  return new Set(done.stdout.split("\0").filter(Boolean).map((name) => name.normalize("NFC")));
};

/** What git holds under `root`. */
export const gitListing = (root: string): GitListing =>
  cached("git", root, () => {
    const tracked = gitFiles(root);
    const visible = new Set([...tracked, ...gitFiles(root, "--others", "--exclude-standard")]);
    const dirs = new Set<string>();
    for (const file of visible) {
      for (let at = file.indexOf("/"); at !== -1; at = file.indexOf("/", at + 1)) dirs.add(file.slice(0, at));
    }
    return { tracked, visible, dirs };
  });

/** True if git's listing holds `name` as a file, as a directory, or below a tracked symlink. */
export function listed({ visible, dirs }: GitListing, name: string): boolean {
  if (visible.has(name) || dirs.has(name)) return true;
  const parts = name.split("/");
  for (let i = 1; i < parts.length; i += 1) if (visible.has(parts.slice(0, i).join("/"))) return true;
  return false;
}
