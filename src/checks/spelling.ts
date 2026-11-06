/** The spell check, through cspell. */

import { runTool } from "../tools.ts";

export interface SpellingResult {
  output: string;
  warnings: number;
  failed: boolean;
}

/**
 * Cspell exits 1 on findings and on a config it could not load alike. Only findings print to stdout,
 * so a failure with nothing there is the tool failing, not a warning. It takes the list on stdin, where
 * no character in a name can make it a glob and no length can overflow a command line.
 */
export function runSpelling(files: string[]): SpellingResult {
  const args = ["--no-progress", "--no-summary", "--no-must-find-files", "--dot", "--file-list", "stdin"];
  const { status, stdout } = runTool("cspell", args, {
    input: files.join("\n"),
    stdio: ["pipe", "pipe", "inherit"],
  });
  return {
    output: stdout,
    warnings: stdout.split("\n").filter(Boolean).length,
    failed: status === null || (status !== 0 && !stdout),
  };
}
