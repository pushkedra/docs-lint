/** The hard-wrap check, and its fix: the same comparison, written back. */

import { readFileSync, writeFileSync } from "node:fs";
import { reflow } from "../reflow/reflow.ts";

/** The line of the first fold `text` needs, or nothing if it needs none. */
export function firstWrappedLine(text: string): number | null {
  const before = text.split("\n");
  const after = reflow(text).split("\n");
  const at = before.findIndex((line, index) => line !== after[index]);
  return at === -1 ? null : at + 1;
}

/** Check or rewrite `paths`, skipping the ignored ones. Returns the files that differ. */
export function reflowFiles(
  paths: string[],
  { check, ignored }: { check: boolean; ignored: (name: string) => boolean },
): string[] {
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
