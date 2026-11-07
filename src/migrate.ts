/**
 * `docs-lint migrate`: turn the markdownlint config at the root into a `.markdownlint-cli2.mjs`.
 *
 * Only what differs from the base moves. A copy of every rule would pin them all, and the repository
 * would stop receiving the base's changes. A rule the old config never named stays the base's for the
 * same reason, even where that changes what it reports.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { load } from "js-yaml";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { withBase, type BaseOptions } from "./config/markdownlint.ts";
import { isLintConfig, listFiles, rivalConfigs } from "./files.ts";
import { fail } from "./output.ts";

const TARGET = ".markdownlint-cli2.mjs";

type Fields = Record<string, unknown>;

function readConfig(source: string): Fields {
  const text = readFileSync(source, "utf8");
  if (/\.ya?ml$/.test(source)) return load(text) as Fields | undefined ?? {};
  const errors: ParseError[] = [];
  const parsed = parse(text, errors, { allowTrailingComma: true }) as Fields | undefined;
  for (const { error, offset } of errors) fail(`cannot read ${source}: ${printParseErrorCode(error)} at offset ${offset}`);
  return parsed ?? {};
}

/** What a repository's config says beyond the base, and what a person should read about it. */
function difference(source: string): { own: BaseOptions; notes: string[] } {
  const read = readConfig(source);
  if (typeof read !== "object" || Array.isArray(read)) fail(`${source} does not hold an object`);
  // Only markdownlint-cli2's own format says anything about which files are read.
  const isCli2 = source.startsWith(".markdownlint-cli2.");
  const options: Fields = isCli2 ? { ...read } : { config: read };
  const config = { ...options.config as Fields | undefined };
  if (config.extends) fail(`${source} extends ${JSON.stringify(config.extends)}. Merge the two by hand, then migrate.`);
  delete config.extends;
  delete config.$schema;
  delete options.$schema;

  withBase({ ...options, config });
  const base = withBase();
  const baseConfig = base.config as Fields;
  const notes: string[] = [];

  const own: Fields = {};
  const rules = Object.entries(config).filter(([rule, value]) =>
    !isDeepStrictEqual(value, baseConfig[rule])
    // A rule the base does not name is already on, unless the old config turned the default off.
    && !(value === true && !(rule in baseConfig) && config.default !== false));
  if (rules.length) own.config = Object.fromEntries(rules);

  const replaced = rules.filter(([rule]) => rule in baseConfig).map(([rule]) => rule);
  if (replaced.length) notes.push(`replaces the base's ${replaced.join(", ")}: delete the key to take the base's, now and in later versions`);
  const off = rules.filter(([, value]) => value === false).map(([rule]) => rule);
  if (off.length) notes.push(`turns off ${off.join(", ")}: a finding is fixed rather than silenced, so read why before keeping it`);
  if (config.default === false) notes.push("default: false ran only the rules it named, and the rules the base names stay on");

  for (const [name, value] of Object.entries(options)) {
    if (name === "config") continue;
    if (name === "ignores") {
      const added = (value as string[]).filter((glob) => !base.ignores?.includes(glob));
      if (added.length) own.ignores = added;
    } else if (!isDeepStrictEqual(value, (base as Fields)[name])) {
      own[name] = value;
    }
  }

  // markdownlint-cli2 reads what is gitignored unless told otherwise, and the base does the opposite.
  if (isCli2 && options.gitignore === undefined) own.gitignore = false;
  if (own.gitignore === false) notes.push("gitignore: false keeps reading gitignored files, as the old config did; delete it to take git's list");

  return { own, notes };
}

const render = (own: BaseOptions): string => {
  const literal = JSON.stringify(own, null, 2).replace(/^( *)"([A-Za-z_$][\w$]*)":/gm, "$1$2:");
  return `// @ts-check\nimport { withBase } from "docs-lint/markdownlint";\n\nexport default withBase(${literal});\n`;
};

export function migrate({ write }: { write: boolean }): void {
  const cwd = process.cwd();
  const rivals = rivalConfigs(cwd, listFiles(cwd, { gitignore: true, ignored: () => false }));
  const sources = rivals.filter((name) => !name.includes("/") && isLintConfig(name));
  const left = rivals.filter((name) => !sources.includes(name));

  const [source] = sources;
  if (!source) console.log("docs-lint: no markdownlint config at the root to migrate");
  else {
    if (sources.length > 1) fail(`more than one markdownlint config at the root. Keep the one that decides, then migrate:\n  ${sources.join("\n  ")}`);
    if (/\.[cm]js$/.test(source)) fail(`${source} is code and cannot be read as settings. Rewrite it by hand; the README shows the file.`);

    const { own, notes } = difference(source);
    const text = render(own);
    if (write) {
      if (existsSync(TARGET)) fail(`${TARGET} is already here and is not overwritten. Run without --write and merge what it prints by hand.`);
      writeFileSync(TARGET, text);
      rmSync(source);
      console.log(`docs-lint: wrote ${TARGET} and removed ${source}, whose comments did not move`);
    } else {
      process.stdout.write(text);
      console.error(`docs-lint: nothing written. --write creates ${TARGET} and removes ${source}, whose comments do not move.`);
    }
    for (const note of notes) console.error(`docs-lint: ${note}`);
  }
  if (left.length) console.error(`docs-lint: these still stop a run, so remove them; a nested one may be named in ignores instead:\n  ${left.join("\n  ")}`);
}
