/** How a line of markdown is recognized, for the folding in `reflow.ts`. */

// Whitespace is this fixed set rather than JavaScript's own: `\s` and `trim()`
// also take U+FEFF, which is text anywhere but at the very start of a file, and
// `reflow` takes it off there.
const WS = String.raw`\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000`;

// A RegExp whose `\s` and `\S` mean the whitespace above, outside a character
// class only. `s` lets `.` match a carriage return. `\d` stays ASCII: CommonMark
// allows only ASCII digits in a list marker.
const re = (source: string, flags = ""): RegExp =>
  new RegExp(source.replaceAll(String.raw`\S`, `[^${WS}]`).replaceAll(String.raw`\s`, `[${WS}]`), flags + "s");

export const FENCE = re(String.raw`^(\s*)(\`{3,}|~{3,})(.*)$`);
const ATX = re(String.raw`^\s{0,3}#{1,6}(\s|$)`);
// Written out rather than through re(): its `\s` also sits inside character classes.
const THEMATIC = new RegExp(
  String.raw`^[${WS}]{0,3}(\*[${WS}]*\*[${WS}]*\*[${WS}*]*|-[${WS}]*-[${WS}]*-[${WS}-]*|_[${WS}]*_[${WS}]*_[${WS}_]*)$`,
  "s",
);
const SETEXT = re(String.raw`^\s{0,3}(=+|-+)\s*$`);
export const LIST = re(String.raw`^(\s*)([-*+]|\d{1,9}[.)])(\s+)(\S.*)$`);
export const BQ = re(String.raw`^(\s{0,3}>\s?)(.*)$`);
const LINKREF = re(String.raw`^\s{0,3}\[[^\]]+\]:\s`);
export const HTMLISH = re(String.raw`^\s{0,3}<[a-zA-Z!/?]`);
const TABLE = re(String.raw`^\s*\|`);
const HARDBREAK = re(String.raw`\S {2,}$`);
const BACKSLASH = /\\$/;
export const INDENT4 = re(String.raw`^(?: {4}| {0,3}\t)\s*\S`);
// Line-oriented syntax beyond CommonMark, which means something else once joined to its neighbor: a
// GitHub alert's marker, a container's fence, display math, a template's tag, a definition, an import.
const ALERT = /^\[![A-Za-z]+\]$/;
const CONTAINER = /^:::/;
const MATH = /^\$\$/;
const TEMPLATE_TAG = /^(?:\{%.*%\}|\{\{.*\}\})$/;
const DEFINITION = /^:\s/;
const IMPORT = /^@\S+$/;
const TABLE_DELIMITER = re(String.raw`^\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$`);

// CommonMark HTML blocks that end at a marker rather than at a blank line: raw
// text elements, comments, processing instructions, declarations and CDATA. Each
// pair is the opener and what closes it, which may sit on the opener's own line.
export const HTML_TO_MARKER = [
  [re(String.raw`^\s{0,3}<(pre|script|style|textarea)(\s|>|$)`, "i"), /<\/(pre|script|style|textarea)>/i],
  [re(String.raw`^\s{0,3}<!--`), /-->/],
  [re(String.raw`^\s{0,3}<\?`), /\?>/],
  [re(String.raw`^\s{0,3}<!\[CDATA\[`), /\]\]>/],
  [re(String.raw`^\s{0,3}<![A-Za-z]`), />/],
];

// By hand rather than by a pattern: `[ ]+$` retries from every space of a run, which is quadratic.
const SPACE = new RegExp(`^[${WS}]$`);
export const rstrip = (s: string): string => {
  let end = s.length;
  while (end > 0 && SPACE.test(s[end - 1])) end -= 1;
  return s.slice(0, end);
};
export const strip = (s: string): string => {
  const end = rstrip(s).length;
  let start = 0;
  while (start < end && SPACE.test(s[start])) start += 1;
  return s.slice(start, end);
};
export const lstripSpaces = (s: string): string => s.replace(/^ +/, "");

/**
 * True if the line opens a block that must not be folded into a paragraph.
 *
 * Classified on the *stripped* line. A fence, table or setext rule nested inside
 * a list item is indented past the anchors these patterns use, and missing one
 * of those folds a code block into prose.
 */
export function blocky(line: string): boolean {
  const stripped = strip(line);
  if (!stripped) return true;
  return [
    ATX, THEMATIC, SETEXT, FENCE, TABLE, TABLE_DELIMITER, LIST, BQ, LINKREF, HTMLISH,
    ALERT, CONTAINER, MATH, TEMPLATE_TAG, DEFINITION, IMPORT,
  ].some((pattern) => pattern.test(stripped));
}

/**
 * True if a paragraph must not continue past this line.
 *
 * A two-space hard break and a trailing backslash are both line breaks the
 * author asked for, so a join must not swallow them.
 */
export function stopsAfter(line: string): boolean {
  return HARDBREAK.test(line) || BACKSLASH.test(line);
}

/**
 * True if `candidate` is a closing fence for an opener of this size.
 *
 * A closing fence carries no info string, so a ```lang line inside a ``` block
 * does not close it — but the bare ``` that ends that inner block does. Getting
 * this wrong truncates the outer block and folds its code into prose.
 */
export function closes(candidate: string, marker: string, width: number): boolean {
  const match = FENCE.exec(strip(candidate));
  return Boolean(match?.[2].startsWith(marker) && match[2].length >= width && !strip(match[3]));
}

/** True if `line` heads a table whose rows open with no pipe, as `next` shows by being its delimiter row. */
export const headsTable = (line: string, next = ""): boolean => line.includes("|") && TABLE_DELIMITER.test(next);
