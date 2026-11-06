/** Which files hold a table row whose code has a bare pipe, the one thing MD060's fix cannot lay out safely. */

import { strip } from "../reflow/syntax.ts";

const withoutQuote = (line: string): string => strip(line.replace(/^[\s>]*/, ""));

function isDelimiterRow(line: string): boolean {
  const row = withoutQuote(line);
  if (!row.includes("|")) return false;
  const cells = row.replace(/^\|/, "").replace(/\|$/, "").split("|");
  return cells.every((cell) => /^:?-+:?$/.test(strip(cell)));
}

function hasPipeInCode(row: string): boolean {
  const runs = [...row.matchAll(/`+/g)];
  let open = 0;
  while (open < runs.length) {
    const [ticks] = runs[open];
    const close = runs.findIndex((run, at) => at > open && run[0] === ticks);
    if (close === -1) {
      open += 1;
      continue;
    }
    if (/(?<!\\)\|/.test(row.slice(runs[open].index + ticks.length, runs[close].index))) return true;
    open = close + 1;
  }
  return false;
}

/**
 * True if a row of a table holds a code span with an unescaped pipe. A line in a fence that only looks like
 * a table counts too: the cost of that is a fix not applied, and the cost of a miss is code rewritten.
 */
export function hasPipeInTableCode(text: string): boolean {
  const lines = text.split("\n");
  return lines.some((line, at) => {
    if (!isDelimiterRow(line)) return false;
    if (at > 0 && hasPipeInCode(lines[at - 1])) return true;
    for (let row = at + 1; row < lines.length && withoutQuote(lines[row]); row += 1) {
      if (hasPipeInCode(lines[row])) return true;
    }
    return false;
  });
}
