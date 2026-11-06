/**
 * Join hard-wrapped Markdown paragraphs back onto a single line.
 *
 * A paragraph is one line — see the MD013 note in `config/markdownlint.ts`. No
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

import {
  blocky, BQ, closes, FENCE, headsTable, HTML_TO_MARKER, HTMLISH, INDENT4, LIST, lstripSpaces, rstrip,
  stopsAfter, strip,
} from "./syntax.ts";

const FRONTMATTER_CLOSERS = new Map([["---", "---"], ["+++", "+++"], ["{", "}"]]);
// A file asks to be left as it is: a verbatim record, or text whose line breaks are its content.
const OPT_OUT = /^[ \t]*<!--[ \t]*markdownlint-disable(?:[ \t]+hard-wrap)?[ \t]*-->[ \t]*$/m;

/** Where the fold stands in a file. */
interface Cursor {
  lines: string[];
  at: number;
  out: string[];
}

/** One kind of block: takes the lines at the cursor and returns true, or leaves them and returns false. */
type Block = (cursor: Cursor) => boolean;

function copyWhile(cursor: Cursor, keeps: (line: string) => unknown): void {
  while (cursor.at < cursor.lines.length && keeps(cursor.lines[cursor.at])) {
    cursor.out.push(cursor.lines[cursor.at]);
    cursor.at += 1;
  }
}

function copyThrough(cursor: Cursor, isLast: (line: string) => boolean): void {
  while (cursor.at < cursor.lines.length) {
    const line = cursor.lines[cursor.at];
    cursor.out.push(line);
    cursor.at += 1;
    if (isLast(line)) return;
  }
}

function copyOne(cursor: Cursor): void {
  cursor.out.push(cursor.lines[cursor.at]);
  cursor.at += 1;
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
 * The run starting at the cursor with `first`: `accept` gives each following line's text to join, or
 * null where the run ends. One line stays as written, and more become `prefix` and their fold.
 */
function foldRun(
  cursor: Cursor,
  first: string,
  prefix: string,
  accept: (line: string, next?: string) => string | null,
): void {
  const { lines, at } = cursor;
  const parts = [first];
  let end = at + 1;
  while (end < lines.length && !stopsAfter(lines[end - 1])) {
    const part = accept(lines[end], lines[end + 1]);
    if (part === null) break;
    parts.push(part);
    end += 1;
  }
  cursor.out.push(parts.length > 1 ? prefix + fold(parts) : lines[at]);
  cursor.at = end;
}

const quotedInner = (line?: string): string | undefined => BQ.exec(line ?? "")?.[2];

/** Fenced code, copied through to its closing fence. */
const fencedCode: Block = (cursor) => {
  const opener = FENCE.exec(cursor.lines[cursor.at]);
  if (!opener) return false;
  copyOne(cursor);
  copyThrough(cursor, (line) => closes(line, opener[2][0], opener[2].length));
  return true;
};

/** Display math, copied through to its closing line. */
const displayMath: Block = (cursor) => {
  if (strip(cursor.lines[cursor.at]) !== "$$") return false;
  copyOne(cursor);
  copyThrough(cursor, (line) => strip(line) === "$$");
  return true;
};

/**
 * An HTML block, copied through to its end. Its lines are markup or literal
 * text, not paragraph prose: joining them collapses a `<pre>` and rewrites
 * the layout of whatever a comment carries. A comment or `<pre>` ends at
 * its closing marker; any other HTML block ends at the first blank line.
 */
const htmlBlock: Block = (cursor) => {
  const line = cursor.lines[cursor.at];
  if (!HTMLISH.test(line)) return false;
  const pair = HTML_TO_MARKER.find(([start]) => start.test(line));
  if (pair) copyThrough(cursor, (candidate) => pair[1].test(candidate));
  else copyWhile(cursor, strip);
  return true;
};

/**
 * A fenced block inside a blockquote, also copied verbatim. Without this
 * the quoted code lines look like ordinary quoted prose and get folded.
 */
const quotedFence: Block = (cursor) => {
  const quoted = BQ.exec(cursor.lines[cursor.at]);
  const inner = quoted && FENCE.exec(strip(quoted[2]));
  if (!inner) return false;
  copyOne(cursor);
  while (cursor.at < cursor.lines.length) {
    const next = BQ.exec(cursor.lines[cursor.at]);
    if (!next) break;
    copyOne(cursor);
    if (closes(next[2], inner[2][0], inner[2].length)) break;
  }
  return true;
};

/** A table with no leading pipes inside a blockquote, copied through to the quote's first blank line. */
const quotedTable: Block = (cursor) => {
  const inner = quotedInner(cursor.lines[cursor.at]);
  if (inner === undefined || !headsTable(inner, quotedInner(cursor.lines[cursor.at + 1]))) return false;
  copyWhile(cursor, (line) => strip(quotedInner(line) ?? ""));
  return true;
};

/**
 * A run of plain quoted prose. A bare `>` separates two paragraphs inside
 * the quote and ends the run; quoted content indented four spaces is code.
 */
const quotedProse: Block = (cursor) => {
  const quoted = BQ.exec(cursor.lines[cursor.at]);
  if (!quoted || !strip(quoted[2]) || blocky(quoted[2]) || INDENT4.test(quoted[2])) return false;
  foldRun(cursor, quoted[2], `${rstrip(quoted[1])} `, (line, next) => {
    const inner = quotedInner(line);
    if (inner === undefined || !strip(inner) || blocky(inner) || INDENT4.test(inner)) return null;
    return headsTable(inner, quotedInner(next)) ? null : inner;
  });
  return true;
};

/** A list item, folded with its indented continuation lines. */
const listItem: Block = (cursor) => {
  const item = LIST.exec(cursor.lines[cursor.at]);
  if (!item) return false;
  const [, indent, marker, gap, first] = item;

  // A fence opened on the list marker, copied through to its closing fence.
  const opener = FENCE.exec(strip(first));
  if (opener) {
    copyOne(cursor);
    copyThrough(cursor, (line) => closes(line, opener[2][0], opener[2].length));
    return true;
  }

  // A table with no leading pipes on the list marker, copied through to the first blank line.
  if (headsTable(first, cursor.lines[cursor.at + 1])) {
    copyWhile(cursor, strip);
    return true;
  }

  const continuation = indent.length + marker.length + gap.length;
  foldRun(cursor, first, indent + marker + gap, (line, next) => {
    if (!strip(line) || blocky(line)) return null;
    return line.length - lstripSpaces(line).length < continuation || headsTable(line, next) ? null : line;
  });
  return true;
};

/** A table with no leading pipes, copied through to the first blank line. */
const pipelessTable: Block = (cursor) => {
  if (!headsTable(cursor.lines[cursor.at], cursor.lines[cursor.at + 1])) return false;
  copyWhile(cursor, strip);
  return true;
};

/** A plain paragraph. */
const paragraph: Block = (cursor) => {
  const line = cursor.lines[cursor.at];
  if (blocky(line) || INDENT4.test(line)) return false;
  const indent = line.slice(0, line.length - lstripSpaces(line).length);
  foldRun(cursor, line, indent, (candidate, next) =>
    blocky(candidate) || INDENT4.test(candidate) || headsTable(candidate, next) ? null : candidate);
  return true;
};

// In this order: a quoted fence has to be seen before quoted prose, and a list item before a paragraph.
const BLOCKS = [
  fencedCode, displayMath, htmlBlock, quotedFence, quotedTable, quotedProse, listItem, pipelessTable, paragraph,
];

/** Frontmatter, in YAML, TOML or JSON, is copied through untouched. */
function copyFrontmatter(cursor: Cursor): void {
  const closer = FRONTMATTER_CLOSERS.get(strip(cursor.lines[0]));
  if (!closer) return;
  copyOne(cursor);
  copyThrough(cursor, (line) => strip(line) === closer);
}

function foldParagraphs(text: string): string {
  const cursor: Cursor = { lines: text.split("\n"), at: 0, out: [] };
  copyFrontmatter(cursor);
  while (cursor.at < cursor.lines.length) {
    if (!BLOCKS.some((block) => block(cursor))) copyOne(cursor);
  }
  return cursor.out.join("\n");
}

/**
 * Return `text` with its hard-wrapped paragraphs folded onto one line. A byte-order mark and CRLF line
 * endings are taken off first and put back after, since either would hide the frontmatter or a hard
 * break from the patterns above. A file with nothing to fold comes back exactly as it was.
 */
export function reflow(text: string): string {
  const bom = text.startsWith("﻿") ? "﻿" : "";
  const body = text.slice(bom.length).replaceAll("\r\n", "\n");
  if (OPT_OUT.test(body)) return text;
  const folded = foldParagraphs(body);
  if (folded === body) return text;
  return bom + (text.includes("\r\n") ? folded.replaceAll("\n", "\r\n") : folded);
}
