/** The markdown lint and the link rule, through markdownlint-cli2. */

import { fileURLToPath } from "node:url";
import { STRUCTURED_OUTPUT_ENV, FIX_PASS_ENV, FIX_PASS_KEEPING_TABLES } from "../config/markdownlint.ts";
import { fail } from "../output.ts";
import type { FileFinding } from "../rules/links/rule.ts";
import { runScript } from "../tools.ts";

const WORKER = fileURLToPath(new URL("lint-worker.js", import.meta.url));

export interface LintResult {
  found: boolean;
  findings: FileFinding[];
  /** Anything markdownlint-cli2 printed that is not findings. */
  unparsed: string;
}

function parseFindings(stdout: string): FileFinding[] | null {
  try {
    return JSON.parse(stdout) as FileFinding[];
  } catch {
    return null;
  }
}

/** Markdownlint-cli2 over `files`. It exits 1 on findings and above that on a failure. */
export function runLint(files: string[], { fix = false, keepTables = false } = {}): LintResult {
  const fixPass = fix ? { [FIX_PASS_ENV]: keepTables ? FIX_PASS_KEEPING_TABLES : "1" } : {};
  const env = { ...process.env, [STRUCTURED_OUTPUT_ENV]: "1", ...fixPass };
  // A leading colon makes the path literal: `app/(group)/x.md` and `!x.md` would otherwise be patterns,
  // match nothing, and pass.
  const argv = ["--no-globs", ...files.map((file) => `:${file}`), ...(fix ? ["--fix"] : [])];
  const { status, stdout, stderr, error } = runScript("markdownlint-cli2", WORKER, [], { env, input: JSON.stringify(argv) });
  if (status === null || status > 1) {
    fail(`markdownlint-cli2 failed\n${[error?.message, stdout, stderr].filter(Boolean).join("\n")}`);
  }

  const parsed = parseFindings(stdout);
  return { found: status === 1, findings: parsed ?? [], unparsed: parsed ? "" : stdout + stderr };
}

/** A finding in the form markdownlint-cli2 prints by default, which editors and people already read. */
export function formatFinding(finding: FileFinding): string {
  const { fileName, lineNumber, errorRange, severity, ruleNames, ruleDescription, errorDetail, errorContext } = finding;
  const column = errorRange?.[0] ? `:${errorRange[0]}` : "";
  const detail = errorDetail ? ` [${errorDetail}]` : "";
  const context = errorContext ? ` [Context: "${errorContext}"]` : "";
  return `${fileName}:${lineNumber}${column} ${severity} ${ruleNames.join("/")} ${ruleDescription}${detail}${context}`;
}
