/**
 * Relative links. One must reach a file, in the exact case, and a heading if it names one. From a tracked
 * file it must also stay inside the repository and off gitignored paths, because both resolve on the
 * machine that wrote them and nowhere else.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { cached } from "./cache.ts";
import { gitListing, listed } from "./git.ts";
import { anchorsOf } from "./tokens.ts";

export interface LocalFinding {
  detail: string;
  target: string;
}

const LINE_FRAGMENT = /^L\d+(?:C\d+)?(?:-L\d+(?:C\d+)?)?$/;
const MARKDOWN_FILE = /\.(?:md|markdown)$/i;

const decode = (text: string): string => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

const posix = (path: string): string => path.split(sep).join("/").normalize("NFC");

const within = (dir: string, path: string): boolean => {
  const name = posix(relative(dir, path));
  return name !== ".." && !name.startsWith("../") && !isAbsolute(name);
};

const entriesOf = (dir: string): string[] =>
  cached("entries", dir, () => {
    try {
      return readdirSync(dir).map((name) => name.normalize("NFC"));
    } catch {
      return [];
    }
  });

/**
 * Why `name` under `root` cannot be reached, or nothing when it can. Component by component, because
 * the filesystem of a Mac would find `Readme.md` for `README.md`, and the clone on Linux would not.
 */
function unreachable(root: string, name: string): string | null {
  let dir = root;
  for (const part of name.split("/").filter(Boolean)) {
    const entries = entriesOf(dir);
    if (!entries.includes(part.normalize("NFC"))) {
      const other = entries.find((entry) => entry.toLowerCase() === part.normalize("NFC").toLowerCase());
      return other ? `the file on disk is spelled ${other}` : "no such file";
    }
    dir = join(dir, part);
  }
  return existsSync(dir) ? null : "no such file";
}

/** Why a link to a local path does not hold, with the repository path it aims at. */
export function checkLocal(
  destination: string,
  source: string,
  root: string | null,
  allowedRoots: string[],
): LocalFinding | null {
  const [, rawPath = "", fragment = ""] = /^([^?#]*)(?:\?[^#]*)?(?:#(.*))?$/s.exec(destination) ?? [];
  const path = decode(rawPath);
  if (!path) return null;
  const home = root ?? process.cwd();
  // GitHub reads a leading slash as the repository's root, so it is not a path on the disk.
  const target = resolve(path.startsWith("/") ? home : dirname(source), path.replace(/^\/+/, ""));
  const name = posix(relative(home, target));
  const inside = within(home, target);
  const listing = root && gitListing(root);
  const fromTracked = listing && listing.tracked.has(posix(relative(root, source)));

  // A sibling this repository is kept beside: the link leaves it on purpose, and still has to resolve.
  const sibling = allowedRoots.map((allowed) => resolve(home, allowed)).find((allowed) => within(allowed, target));
  if (!inside && !sibling && fromTracked) return { detail: "leaves the repository", target: name };
  const base = inside || sibling ? sibling ?? home : null;
  const problem = base ? unreachable(base, posix(relative(base, target))) : existsSync(target) ? null : "no such file";
  if (problem) return { detail: problem, target: name };
  if (inside && listing && fromTracked && name && !listed(listing, name)) {
    return { detail: "gitignored, so a clone does not have it", target: name };
  }

  const anchor = decode(fragment);
  if (anchor && !LINE_FRAGMENT.test(anchor) && MARKDOWN_FILE.test(path) && statSync(target).isFile()) {
    if (!anchorsOf(target).has(anchor)) return { detail: `no heading for #${anchor}`, target: name };
  }
  return null;
}
