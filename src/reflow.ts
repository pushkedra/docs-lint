/**
 * Join hard-wrapped Markdown paragraphs back onto a single line.
 *
 * A paragraph is one line — see the MD013 note in `config/markdownlint.mjs`. No
 * lint rule can see a hard-wrapped paragraph, so this is both the check and the fix.
 *
 * It is conservative by construction: it folds a run of plain paragraph lines and
 * nothing else, and every construct that could mean something different once its
 * line breaks are gone ends the run. Those are fenced and indented code, tables,
 * headings, setext underlines, thematic breaks, link reference definitions, HTML
 * blocks, list markers, the bare `>` that separates two paragraphs inside a
 * blockquote, and a line ending in a two-space hard break or a backslash.
 *
 * Node built-ins only, so it adds nothing to what the package installs.
 */

import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

// Whitespace is this fixed set rather than JavaScript's own: `\s` and `trim()`
// also take U+FEFF, which is text anywhere but at the very start of a file, and
// `reflow` takes it off there.
const WS = String.raw`\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000`;

// A RegExp whose `\s` and `\S` mean the whitespace above, outside a character
// class only. `s` lets `.` match a carriage return. `\d` stays ASCII: CommonMark
// allows only ASCII digits in a list marker.
const re = (source: string, flags = ""): RegExp =>
  new RegExp(source.replaceAll(String.raw`\S`, `[^${WS}]`).replaceAll(String.raw`\s`, `[${WS}]`), flags + "s");

const FENCE = re(String.raw`^(\s*)(\`{3,}|~{3,})(.*)$`);
const ATX = re(String.raw`^\s{0,3}#{1,6}(\s|$)`);
// Written out rather than through re(): its `\s` also sits inside character classes.
const THEMATIC = new RegExp(
  String.raw`^[${WS}]{0,3}(\*[${WS}]*\*[${WS}]*\*[${WS}*]*|-[${WS}]*-[${WS}]*-[${WS}-]*|_[${WS}]*_[${WS}]*_[${WS}_]*)$`,
  "s",
);
const SETEXT = re(String.raw`^\s{0,3}(=+|-+)\s*$`);
const LIST = re(String.raw`^(\s*)([-*+]|\d{1,9}[.)])(\s+)(\S.*)$`);
const BQ = re(String.raw`^(\s{0,3}>\s?)(.*)$`);
const LINKREF = re(String.raw`^\s{0,3}\[[^\]]+\]:\s`);
const HTMLISH = re(String.raw`^\s{0,3}<[a-zA-Z!/?]`);
const TABLE = re(String.raw`^\s*\|`);
const HARDBREAK = re(String.raw`\S {2,}$`);
const BACKSLASH = /\\$/;
const INDENT4 = re(String.raw`^(?: {4}| {0,3}\t)\s*\S`);
// Line-oriented syntax beyond CommonMark, which means something else once joined to its neighbor: a
// GitHub alert's marker, a container's fence, display math, a template's tag, a definition, an import.
const ALERT = /^\[![A-Za-z]+\]$/;
const CONTAINER = /^:::/;
const MATH = /^\$\$/;
const TEMPLATE_TAG = /^(?:\{%.*%\}|\{\{.*\}\})$/;
const DEFINITION = /^:\s/;
const IMPORT = /^@\S+$/;
const FRONTMATTER_CLOSERS: Record<string, string> = { "---": "---", "+++": "+++", "{": "}" };
// A file asks to be left as it is: a verbatim record, or text whose line breaks are its content.
const OPT_OUT = /^[ \t]*<!--[ \t]*markdownlint-disable(?:[ \t]+hard-wrap)?[ \t]*-->[ \t]*$/m;
const TABLE_DELIMITER = re(String.raw`^\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$`);

// CommonMark HTML blocks that end at a marker rather than at a blank line: raw
// text elements, comments, processing instructions, declarations and CDATA. Each
// pair is the opener and what closes it, which may sit on the opener's own line.
const HTML_TO_MARKER = [
  [re(String.raw`^\s{0,3}<(pre|script|style|textarea)(\s|>|$)`, "i"), /<\/(pre|script|style|textarea)>/i],
  [re(String.raw`^\s{0,3}<!--`), /-->/],
  [re(String.raw`^\s{0,3}<\?`), /\?>/],
  [re(String.raw`^\s{0,3}<!\[CDATA\[`), /\]\]>/],
  [re(String.raw`^\s{0,3}<![A-Za-z]`), />/],
];

// By hand rather than by a pattern: `[ ]+$` retries from every space of a run, which is quadratic.
const SPACE = new RegExp(`^[${WS}]$`);
const rstrip = (s: string): string => {
  let end = s.length;
  while (end > 0 && SPACE.test(s[end - 1])) end -= 1;
  return s.slice(0, end);
};
const strip = (s: string): string => {
  const end = rstrip(s).length;
  let start = 0;
  while (start < end && SPACE.test(s[start])) start += 1;
  return s.slice(start, end);
};
const lstripSpaces = (s: string): string => s.replace(/^ +/, "");

/**
 * True if the line opens a block that must not be folded into a paragraph.
 *
 * Classified on the *stripped* line. A fence, table or setext rule nested inside
 * a list item is indented past the anchors these patterns use, and missing one
 * of those folds a code block into prose.
 */
function blocky(line: string): boolean {
  const stripped = strip(line);
  if (!stripped) return true;
  return [
    ATX, THEMATIC, SETEXT, FENCE, TABLE, TABLE_DELIMITER, LIST, BQ, LINKREF, HTMLISH,
    ALERT, CONTAINER, MATH, TEMPLATE_TAG, DEFINITION, IMPORT,
  ].some((re) => re.test(stripped));
}

/**
 * True if a paragraph must not continue past this line.
 *
 * A two-space hard break and a trailing backslash are both line breaks the
 * author asked for, so a join must not swallow them.
 */
function stopsAfter(line: string): boolean {
  return HARDBREAK.test(line) || BACKSLASH.test(line.replace(/\n+$/, ""));
}

/**
 * The lines of one run, folded onto one line.
 *
 * The last line keeps its trailing whitespace when that whitespace is a hard
 * break: stripping it would turn the break into a join on the next run, so the
 * tool would not reach a fixed point in one pass.
 */
function fold(parts: string[]): string {
  const joined = parts.map(strip).join(" ");
  const last = parts[parts.length - 1] ?? "";
  return stopsAfter(last) ? joined + last.slice(rstrip(last).length) : joined;
}

/**
 * True if `candidate` is a closing fence for an opener of this size.
 *
 * A closing fence carries no info string, so a ```lang line inside a ``` block
 * does not close it — but the bare ``` that ends that inner block does. Getting
 * this wrong truncates the outer block and folds its code into prose.
 */
function closes(candidate: string, marker: string, width: number): boolean {
  const match = FENCE.exec(strip(candidate));
  return Boolean(match?.[2].startsWith(marker) && match[2].length >= width && !strip(match[3]));
}

/** True if `line` heads a table whose rows open with no pipe, as `next` shows by being its delimiter row. */
const headsTable = (line: string, next = ""): boolean => line.includes("|") && TABLE_DELIMITER.test(next);

/**
 * Return `text` with its hard-wrapped paragraphs folded onto one line. A byte-order mark and CRLF line
 * endings are taken off first and put back after, since either would hide the frontmatter or a hard
 * break from the patterns above. A file with nothing to fold comes back exactly as it was.
 */
export function reflow(text: string): string {
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = text.slice(bom.length).replaceAll("\r\n", "\n");
  if (OPT_OUT.test(body)) return text;
  const folded = foldParagraphs(body);
  if (folded === body) return text;
  return bom + (text.includes("\r\n") ? folded.replaceAll("\n", "\r\n") : folded);
}

function foldParagraphs(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  const n = lines.length;
  const copyWhile = (keeps: (line: string) => unknown): void => {
    while (i < n && keeps(lines[i])) {
      out.push(lines[i]);
      i += 1;
    }
  };
  const copyThrough = (isLast: (line: string) => boolean): void => {
    while (i < n) {
      const done = isLast(lines[i]);
      out.push(lines[i]);
      i += 1;
      if (done) return;
    }
  };

  // Frontmatter, in YAML, TOML or JSON, is copied through untouched.
  const closer = FRONTMATTER_CLOSERS[strip(lines[0])];
  if (closer) {
    out.push(lines[0]);
    i = 1;
    while (i < n && strip(lines[i]) !== closer) {
      out.push(lines[i]);
      i += 1;
    }
    if (i < n) {
      out.push(lines[i]);
      i += 1;
    }
  }

  while (i < n) {
    const line = lines[i];

    // Fenced code, copied through to its closing fence.
    const opener = FENCE.exec(line);
    if (opener) {
      const marker = opener[2][0];
      const width = opener[2].length;
      out.push(line);
      i += 1;
      while (i < n) {
        out.push(lines[i]);
        const closed = closes(lines[i], marker, width);
        i += 1;
        if (closed) break;
      }
      continue;
    }

    // Display math, copied through to its closing line.
    if (strip(line) === "$$") {
      out.push(line);
      i += 1;
      copyThrough((candidate) => strip(candidate) === "$$");
      continue;
    }

    // An HTML block, copied through to its end. Its lines are markup or literal
    // text, not paragraph prose: joining them collapses a `<pre>` and rewrites
    // the layout of whatever a comment carries. A comment or `<pre>` ends at
    // its closing marker; any other HTML block ends at the first blank line.
    if (HTMLISH.test(line)) {
      const pair = HTML_TO_MARKER.find(([start]) => start.test(line));
      if (pair) {
        const end = pair[1];
        let closed = false;
        while (i < n && !closed) {
          closed = end.test(lines[i]);
          out.push(lines[i]);
          i += 1;
        }
      } else {
        while (i < n && strip(lines[i])) {
          out.push(lines[i]);
          i += 1;
        }
      }
      continue;
    }

    const quoted = BQ.exec(line);

    // A fenced block inside a blockquote, also copied verbatim. Without this
    // the quoted code lines look like ordinary quoted prose and get folded.
    if (quoted) {
      const inner = FENCE.exec(strip(quoted[2]));
      if (inner) {
        const marker = inner[2][0];
        const width = inner[2].length;
        out.push(line);
        i += 1;
        while (i < n) {
          const nxt = BQ.exec(lines[i]);
          if (!nxt) break;
          out.push(lines[i]);
          i += 1;
          if (closes(nxt[2], marker, width)) break;
        }
        continue;
      }
    }

    // A table with no leading pipes inside a blockquote, copied through to the quote's first blank line.
    if (quoted && headsTable(quoted[2], BQ.exec(lines[i + 1] ?? "")?.[2])) {
      copyWhile((candidate) => strip(BQ.exec(candidate)?.[2] ?? ""));
      continue;
    }

    // A run of plain quoted prose. A bare `>` separates two paragraphs inside
    // the quote and ends the run; quoted content indented four spaces is code.
    if (quoted && strip(quoted[2]) && !blocky(quoted[2]) && !INDENT4.test(quoted[2])) {
      const parts = [quoted[2]];
      let j = i + 1;
      while (j < n && !stopsAfter(lines[j - 1])) {
        const nxt = BQ.exec(lines[j]);
        if (!nxt || !strip(nxt[2]) || blocky(nxt[2]) || INDENT4.test(nxt[2])) break;
        if (headsTable(nxt[2], BQ.exec(lines[j + 1] ?? "")?.[2])) break;
        parts.push(nxt[2]);
        j += 1;
      }
      if (parts.length > 1) {
        out.push(rstrip(quoted[1]) + " " + fold(parts));
      } else {
        out.push(line);
      }
      i = j;
      continue;
    }

    // A list item, folded with its indented continuation lines.
    const item = LIST.exec(line);
    if (item) {
      const [, indent, marker, gap, first] = item;

      // A fence opened on the list marker, copied through to its closing fence.
      const opener = FENCE.exec(strip(first));
      if (opener) {
        out.push(line);
        i += 1;
        copyThrough((candidate) => closes(candidate, opener[2][0], opener[2].length));
        continue;
      }

      // A table with no leading pipes on the list marker, copied through to the first blank line.
      if (headsTable(first, lines[i + 1])) {
        copyWhile(strip);
        continue;
      }

      const continuation = indent.length + marker.length + gap.length;
      const parts = [first];
      let j = i + 1;
      while (j < n && !stopsAfter(lines[j - 1])) {
        const nxt = lines[j];
        if (!strip(nxt) || blocky(nxt)) break;
        if (nxt.length - lstripSpaces(nxt).length < continuation || headsTable(nxt, lines[j + 1])) break;
        parts.push(nxt);
        j += 1;
      }
      if (parts.length > 1) {
        out.push(indent + marker + gap + fold(parts));
      } else {
        out.push(line);
      }
      i = j;
      continue;
    }

    // A table with no leading pipes, copied through to the first blank line.
    if (headsTable(line, lines[i + 1])) {
      copyWhile(strip);
      continue;
    }

    // A plain paragraph.
    if (!blocky(line) && !INDENT4.test(line)) {
      const indent = line.slice(0, line.length - lstripSpaces(line).length);
      const parts = [line];
      let j = i + 1;
      while (j < n && !stopsAfter(lines[j - 1])) {
        const nxt = lines[j];
        if (blocky(nxt) || INDENT4.test(nxt) || headsTable(nxt, lines[j + 1])) break;
        parts.push(nxt);
        j += 1;
      }
      if (parts.length > 1) {
        out.push(indent + fold(parts));
      } else {
        out.push(line);
      }
      i = j;
      continue;
    }

    out.push(line);
    i += 1;
  }

  return out.join("\n");
}

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
      source += glob[i].replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    } else {
      source += c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
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

/** The line of the first fold `text` needs, or nothing if it needs none. */
export function firstWrappedLine(text: string): number | null {
  const before = text.split("\n");
  const after = reflow(text).split("\n");
  const at = before.findIndex((line, index) => line !== after[index]);
  return at === -1 ? null : at + 1;
}

/** Check or rewrite `paths`, skipping the ignored ones. Returns the files that differ. */
export function reflowFiles(paths: string[], { check, ignored }: { check: boolean; ignored: (name: string) => boolean }): string[] {
  const changed: string[] = [];
  for (const name of paths.filter((path) => !ignored(path))) {
    const source = readFileSync(name, "utf8");
    const folded = reflow(source);
    if (folded === source) continue;
    changed.push(name);
    if (!check) writeFileSync(name, folded, "utf8");
  }
  return changed;
}
