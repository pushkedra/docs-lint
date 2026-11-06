/**
 * The `docs-lint-links` rule: a link in markdown has to lead somewhere a reader can follow.
 *
 * A relative link must reach a file, in the exact case, and a heading if it names one. From a tracked
 * file it must also stay inside the repository and off gitignored paths, because both resolve on the
 * machine that wrote them and nowhere else. An external link is only checked for form, with no request
 * sent: a network failure says nothing about the commit being checked.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { MicromarkToken, Rule } from "markdownlint";
import { lint } from "markdownlint/sync";
import type { LinkOptions } from "./config/markdownlint.ts";
import { ignoredBy } from "./reflow.ts";

export const LINKS_RULE = "docs-lint-links";

interface Link {
  lineNumber: number;
  destination: string;
}

interface Finding {
  detail: string;
  target?: string;
}

interface GitListing {
  tracked: Set<string>;
  visible: Set<string>;
  dirs: Set<string>;
}

/** What the rule reads from its entry in `config`; `into` is set only by `linksInto`. */
interface RuleConfig extends LinkOptions {
  into?: string[];
}

const SCHEME = /^[a-z][a-z\d+.-]*:/i;
const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);
const IMAGE_DATA = /^data:image\//i;
// Plain HTTP, but not to this machine: a README's development server has no HTTPS to link to.
const DENIED_URLS = [/^http:\/\/(?!(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?:[:/?#]|$))/i];
// A template's placeholder, filled in when the file is used, so it is not a path yet: `{{x}}`, `${x}`,
// `{x}`, `<%= x %>`, `https://<host>/x`, `%X%`, and any of them percent-encoded.
const PLACEHOLDER = /[{<>]|%7[Bb]|%3[Cc]|%[A-Z_]+%/;
// `<url>` is the placeholder form, where a real path has a dot or a slash: `<my file.md>`.
const PATHLESS = /^[^./]*$/;
const NAMED_REFERENCES = new Map([["amp", "&"], ["lt", "<"], ["gt", ">"], ["quot", "\""], ["apos", "'"]]);
const LINE_FRAGMENT = /^L\d+(?:C\d+)?(?:-L\d+(?:C\d+)?)?$/;
const MARKDOWN_FILE = /\.(?:md|markdown)$/i;
const HTML_LINK = /\s(?:href|src)\s*=\s*["']([^"']+)["']/gi;
const HTML_ID = /\sid\s*=\s*["']?([^"'\s>]+)/i;
const HTML_NAME = /^<a\s(?:[^>]*\s)?name\s*=\s*["']?([^"'\s>]+)/i;
const HEADING_ANCHOR = /\{#([a-z\d]+(?:[-_]+[a-z\d]+)*)\}/gu;
const SLUG_DROPS = /[^\p{Letter}\p{Mark}\p{Number}\p{Connector_Punctuation}\- ]/gu;

// Every answer below is kept for a moment rather than for the process: the CLI ends in seconds, but an
// editor loads this once and would otherwise keep answering from the tree as it first found it.
const CACHE_MS = 2000;
let cache: { at: number; entries: Map<string, unknown> } | undefined;
const cached = <T>(kind: string, key: string, compute: () => T): T => {
  if (!cache || Date.now() - cache.at > CACHE_MS) cache = { at: Date.now(), entries: new Map() };
  const full = `${kind}\0${key}`;
  if (!cache.entries.has(full)) cache.entries.set(full, compute());
  return cache.entries.get(full) as T;
};

const walk = (tokens: MicromarkToken[], visit: (token: MicromarkToken) => void): void => {
  for (const token of tokens) {
    visit(token);
    walk(token.children, visit);
  }
};

const decode = (text: string): string => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

const posix = (path: string): string => path.split(sep).join("/").normalize("NFC");

const referenceValue = (text: string): string => {
  const [, hex = "", decimal = "", name = ""] = /^&(?:#[xX]([\da-fA-F]+)|#(\d+)|(\w+));$/.exec(text) ?? [];
  if (hex || decimal) return String.fromCodePoint(hex ? Number.parseInt(hex, 16) : Number(decimal));
  return NAMED_REFERENCES.get(name) ?? text;
};

/** A destination as it means, with its backslash escapes and character references resolved. */
const plainText = (token: MicromarkToken): string =>
  token.children
    .map((child) => {
      if (child.type === "data" || child.type === "characterEscapeValue") return child.text;
      return child.type === "characterReference" ? referenceValue(child.text) : plainText(child);
    })
    .join("");

/** Every link in the parsed file: what it points at and where it was written. */
function linksIn(tokens: MicromarkToken[]): Link[] {
  const links: Link[] = [];
  walk(tokens, (token) => {
    const { type, startLine: lineNumber, text } = token;
    if (type === "resourceDestinationString" || type === "definitionDestinationString") {
      const destination = plainText(token);
      if (token.parent?.type.endsWith("DestinationLiteral") && PATHLESS.test(destination)) return;
      links.push({ lineNumber, destination });
    } else if (type === "autolinkProtocol") {
      links.push({ lineNumber, destination: text });
    } else if (type === "htmlText" && !text.startsWith("<!--")) {
      for (const [, destination] of text.matchAll(HTML_LINK)) links.push({ lineNumber, destination: destination });
    }
  });
  return links;
}

/**
 * The fragments a markdown file answers to, by the rules MD051 applies inside one file, so that a
 * heading is reachable by the same name from its own file and from any other.
 */
function anchorsIn(tokens: MicromarkToken[]): Set<string> {
  const anchors = new Set(["top"]);
  const counts = new Map<string, number>();
  const slug = (heading: MicromarkToken): string => {
    const parts: string[] = [];
    const collect = (token: MicromarkToken): void => {
      if (["characterEscapeValue", "codeTextData", "data", "mathTextData"].includes(token.type)) parts.push(token.text);
      if (!["image", "reference", "resource"].includes(token.type)) token.children.forEach(collect);
    };
    heading.children.forEach(collect);
    return parts.join("").toLowerCase().replace(SLUG_DROPS, "").replace(/ /gu, "-");
  };
  walk(tokens, (token) => {
    if (token.type === "atxHeadingText" || token.type === "setextHeadingText") {
      const name = slug(token);
      if (!name) return;
      const count = counts.get(name) ?? 0;
      counts.set(name, count + 1);
      anchors.add(count ? `${name}-${count}` : name);
      for (const [, anchor] of token.text.matchAll(HEADING_ANCHOR)) anchors.add(anchor);
    } else if (token.type === "htmlText" && !token.text.startsWith("<!--") && !token.text.startsWith("</")) {
      const match = HTML_ID.exec(token.text) ?? HTML_NAME.exec(token.text);
      if (match) anchors.add(match[1]);
    }
  });
  return anchors;
}

/** The anchors of the file at `path`, read through the parser the rule itself runs on. */
const anchorsOf = (path: string): Set<string> =>
  cached("anchors", path, () => {
    let anchors = new Set<string>();
    const capture: Rule = {
      names: ["docs-lint-anchors"],
      description: "Collect the anchors of a link's target",
      tags: ["links"],
      parser: "micromark",
      function: ({ parsers }) => {
        anchors = anchorsIn(parsers.micromark.tokens);
      },
    };
    lint({
      strings: { [path]: readFileSync(path, "utf8") },
      config: { "default": false, "docs-lint-anchors": true },
      customRules: [capture],
    });
    return anchors;
  });

/**
 * The nearest directory above `path` holding `.git`, walked as spelled. Asking git would resolve
 * symlinks first, and a symlinked directory belongs to the repository it is linked from.
 */
function rootOf(path: string): string | null {
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
const gitListing = (root: string): GitListing =>
  cached("git", root, () => {
    const tracked = gitFiles(root);
    const visible = new Set([...tracked, ...gitFiles(root, "--others", "--exclude-standard")]);
    const dirs = new Set<string>();
    for (const file of visible) for (let at = file.indexOf("/"); at !== -1; at = file.indexOf("/", at + 1)) dirs.add(file.slice(0, at));
    return { tracked, visible, dirs };
  });

/** True if git's listing holds `name` as a file, as a directory, or below a tracked symlink. */
function listed({ visible, dirs }: GitListing, name: string): boolean {
  if (visible.has(name) || dirs.has(name)) return true;
  const parts = name.split("/");
  for (let i = 1; i < parts.length; i += 1) if (visible.has(parts.slice(0, i).join("/"))) return true;
  return false;
}

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

function checkExternal(destination: string, denied: RegExp[]): string | null {
  let url;
  try {
    url = new URL(destination);
  } catch {
    return "not a valid URL";
  }
  if (IMAGE_DATA.test(destination)) return null;
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) return `the protocol ${url.protocol} is not allowed`;
  const pattern = denied.find((re) => re.test(destination));
  return pattern ? `denied by ${String(pattern)}` : null;
}

const within = (dir: string, path: string): boolean => {
  const name = posix(relative(dir, path));
  return name !== ".." && !name.startsWith("../") && !isAbsolute(name);
};

/** Why a link to a local path does not hold, with the repository path it aims at. */
function checkLocal(destination: string, source: string, root: string | null, allowedRoots: string[]): Finding | null {
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
  const problem = inside || sibling ? unreachable(sibling ?? home, posix(relative(sibling ?? home, target))) : existsSync(target) ? null : "no such file";
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

// Without its `g` or `y`, a pattern keeps no position between tests and cannot alternate its answer.
const toRegExps = (patterns: (RegExp | string)[] = []): RegExp[] =>
  patterns.map((pattern) => (pattern instanceof RegExp ? new RegExp(pattern, pattern.flags.replace(/[gy]/g, "")) : new RegExp(pattern)));

export const linksRule: Rule = {
  names: [LINKS_RULE],
  description: "Links should lead somewhere",
  tags: ["links"],
  parser: "micromark",
  function: ({ name, parsers, config: rawConfig }, onError) => {
    const config = rawConfig as RuleConfig;
    const source = resolve(name);
    const root = rootOf(source);
    if (ignoredBy(root ?? process.cwd(), config.excludedSources ?? [])(source)) return;
    const excluded = toRegExps(config.excludedUrls);
    const denied = [...DENIED_URLS, ...toRegExps(config.deniedUrls)];

    for (const { lineNumber, destination } of linksIn(parsers.micromark.tokens)) {
      if (!destination || destination.startsWith("#") || PLACEHOLDER.test(destination)) continue;
      if (excluded.some((re) => re.test(destination))) continue;
      const external = SCHEME.test(destination) || destination.startsWith("//");
      const finding: Finding | null = external
        ? { detail: checkExternal(destination.startsWith("//") ? `https:${destination}` : destination, denied) ?? "" }
        : checkLocal(destination, source, root, config.allowedRoots ?? []);
      if (!finding?.detail) continue;
      const { target } = finding;
      if (config.into && !(target && config.into.some((path) => path === target || path.startsWith(`${target}/`)))) continue;
      onError({ lineNumber, detail: finding.detail, context: destination });
    }
  },
};

/**
 * The findings in `files` whose target is one of `into`. A commit that renames a file or a heading
 * breaks links in files it does not touch, and a check of the staged files alone cannot see those.
 */
export function linksInto(files: string[], into: string[], config: RuleConfig | false): string[] {
  if (config === false || !files.length || !into.length) return [];
  const results = lint({
    files,
    config: { default: false, [LINKS_RULE]: { ...config, into } },
    customRules: [linksRule],
  });
  return Object.entries(results).flatMap(([file, errors]) =>
    errors.map(({ lineNumber, errorDetail, errorContext }) => `${file}:${lineNumber} ${LINKS_RULE} ${errorDetail ?? ""} [Context: "${errorContext ?? ""}"]`),
  );
}
