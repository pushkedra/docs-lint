/** Matching paths against globs, the way markdownlint-cli2 does. */

import { realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

const escapeForRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * A RegExp for one glob, with the semantics markdownlint-cli2 gives `ignores`:
 * matched against the path relative to the config's directory, and with `*` and
 * `**` matching dotfiles too, so a leading `**` reaches a `node_modules` under
 * `.claude/`.
 *
 * Covers `**`, `*`, `?`, `[...]`, `{a,b}` and a backslash escape.
 */
export function globToRegExp(glob: string): RegExp {
  let source = "";
  let depth = 0;
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*" && (i === 0 || glob[i - 1] === "/")) {
      if (i + 2 === glob.length) {
        source += ".*";
        i += 1;
        continue;
      }
      if (glob[i + 2] === "/") {
        source += "(?:[^/]*/)*";
        i += 2;
        continue;
      }
    }
    if (c === "*") {
      source += "[^/]*";
      while (glob[i + 1] === "*") i += 1;
    } else if (c === "?") {
      source += "[^/]";
    } else if (c === "[" && glob.includes("]", i + 2)) {
      const end = glob.indexOf("]", i + 2);
      const body = glob.slice(i + 1, end).replace(/^!/, "^").replaceAll("\\", "\\\\");
      source += `[${body}]`;
      i = end;
    } else if (c === "{") {
      source += "(?:";
      depth += 1;
    } else if (c === "}" && depth) {
      source += ")";
      depth -= 1;
    } else if (c === "," && depth) {
      source += "|";
    } else if (c === "\\" && i + 1 < glob.length) {
      i += 1;
      source += escapeForRegExp(glob[i]);
    } else {
      source += escapeForRegExp(c);
    }
  }
  return new RegExp(`^${source}$`);
}

/**
 * A predicate: true for a path the config in `dir` excludes. No config, no
 * exclusions: every file given is checked.
 *
 * A path is tried both as spelled and with its symlinks resolved: an absolute
 * path through a symlinked directory is outside `dir` as spelled, and a file
 * reached through a symlinked subdirectory is outside it once resolved.
 */
export function ignoredBy(dir: string, ignores: string[]): (name: string) => boolean {
  // Both spellings mean the same to markdownlint-cli2's globbing: `./gen/**`, and `gen/` for a directory.
  const patterns = ignores.map((glob) => globToRegExp(glob.replace(/^\.\//, "").replace(/\/$/, "/**")));
  const real = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  const posix = (from: string, to: string): string => relative(from, to).split(sep).join("/");
  return (name) => {
    const path = resolve(dir, name);
    const spellings = [posix(dir, path), posix(real(dir), real(path))];
    return spellings.some((s) => patterns.some((pattern) => pattern.test(s)));
  };
}
