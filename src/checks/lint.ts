/** The markdown lint and the link rule, through markdownlint-cli2. */

import { STRUCTURED_OUTPUT_ENV, FIX_PASS_ENV } from "../config/markdownlint.ts";
import { fail } from "../output.ts";
import type { FileFinding } from "../rules/links/rule.ts";
import { runTool } from "../tools.ts";

// Under every platform's limit on a command line that this package is tested on, with room for the rest.
const MAX_ARGUMENT_BYTES = 200_000;

export interface LintResult {
  found: boolean;
  findings: FileFinding[];
  /** What a config not built on `withBase` printed, since its formatter is not this package's. */
  unparsed: string;
}

/** `files` in portions a command line can hold. */
function portions(files: string[]): string[][] {
  const result: string[][] = [];
  let portion: string[] = [];
  let bytes = 0;
  for (const file of files) {
    const size = Buffer.byteLength(file) + 2;
    if (bytes + size > MAX_ARGUMENT_BYTES && portion.length) {
      result.push(portion);
      portion = [];
      bytes = 0;
    }
    portion.push(file);
    bytes += size;
  }
  result.push(portion);
  return result;
}

function parseFindings(stdout: string): FileFinding[] | null {
  try {
    return JSON.parse(stdout) as FileFinding[];
  } catch {
    return null;
  }
}

/** Markdownlint-cli2 over `files`. It exits 1 on findings and above that on a failure. */
export function runLint(files: string[], { fix = false } = {}): LintResult {
  const env = { ...process.env, [STRUCTURED_OUTPUT_ENV]: "1", ...(fix ? { [FIX_PASS_ENV]: "1" } : {}) };
  const runs = portions(files).map((portion) =>
    // A leading colon makes the path literal: `app/(group)/x.md` and `!x.md` would otherwise be patterns,
    // match nothing, and pass.
    runTool("markdownlint-cli2", ["--no-globs", ...portion.map((file) => `:${file}`), ...(fix ? ["--fix"] : [])], { env }),
  );
  const failed = runs.find(({ status }) => status === null || status > 1);
  if (failed) fail(`markdownlint-cli2 failed\n${failed.stdout}${failed.stderr}`);

  const findings: FileFinding[] = [];
  let unparsed = "";
  for (const { stdout, stderr } of runs) {
    const parsed = parseFindings(stdout);
    if (parsed) findings.push(...parsed);
    else unparsed += stdout + stderr;
  }
  return { found: runs.some(({ status }) => status === 1), findings, unparsed };
}

/** A finding in the form markdownlint-cli2 prints by default, which editors and people already read. */
export function formatFinding(finding: FileFinding): string {
  const { fileName, lineNumber, errorRange, severity, ruleNames, ruleDescription, errorDetail, errorContext } = finding;
  const column = errorRange?.[0] ? `:${errorRange[0]}` : "";
  const detail = errorDetail ? ` [${errorDetail}]` : "";
  const context = errorContext ? ` [Context: "${errorContext}"]` : "";
  return `${fileName}:${lineNumber}${column} ${severity} ${ruleNames.join("/")} ${ruleDescription}${detail}${context}`;
}
