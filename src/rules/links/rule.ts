/** The `docs-lint-links` rule: a link in markdown has to lead somewhere a reader can follow. */

import { resolve } from "node:path";
import type { LintError, Rule } from "markdownlint";
import { lint } from "markdownlint/sync";
import type { LinkOptions } from "../../config/markdownlint.ts";
import { ignoredBy } from "../../globs.ts";
import { checkExternal, DENIED_URLS } from "./external.ts";
import { rootOf } from "./git.ts";
import { checkLocal } from "./local.ts";
import { linksIn } from "./tokens.ts";

export const LINKS_RULE = "docs-lint-links";

/** A finding with the file it is in, as markdownlint-cli2 hands them to a formatter. */
export interface FileFinding extends LintError {
  fileName: string;
}

/** What the rule reads from its entry in `config`; `into` is set only by `linksInto`. */
interface RuleConfig extends LinkOptions {
  into?: string[];
}

const SCHEME = /^[a-z][a-z\d+.-]*:/i;
// A template's placeholder, filled in when the file is used, so it is not a path yet: `{{x}}`, `${x}`,
// `{x}`, `<%= x %>`, `https://<host>/x`, `%X%`, and any of them percent-encoded.
const PLACEHOLDER = /[{<>]|%7[Bb]|%3[Cc]|%[A-Z_]+%/;

// Without its `g` or `y`, a pattern keeps no position between tests and cannot alternate its answer.
const toRegExps = (patterns: (RegExp | string)[] = []): RegExp[] =>
  patterns.map((pattern) =>
    pattern instanceof RegExp ? new RegExp(pattern, pattern.flags.replace(/[gy]/g, "")) : new RegExp(pattern));

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
      let detail: string | null;
      let target: string | undefined;
      if (SCHEME.test(destination) || destination.startsWith("//")) {
        detail = checkExternal(destination.startsWith("//") ? `https:${destination}` : destination, denied);
      } else {
        const finding = checkLocal(destination, source, root, config.allowedRoots ?? []);
        detail = finding?.detail ?? null;
        target = finding?.target;
      }
      if (!detail) continue;
      if (config.into && !(target && config.into.some((path) => path === target || path.startsWith(`${target}/`)))) continue;
      onError({ lineNumber, detail, context: destination });
    }
  },
};

/**
 * The findings in `files` whose target is one of `into`. A commit that renames a file or a heading
 * breaks links in files it does not touch, and a check of the staged files alone cannot see those.
 */
export function linksInto(files: string[], into: string[], config: LinkOptions | false): FileFinding[] {
  if (config === false || !files.length || !into.length) return [];
  const results = lint({
    files,
    config: { default: false, [LINKS_RULE]: { ...config, into } },
    customRules: [linksRule],
  });
  return Object.entries(results).flatMap(([fileName, errors]) => errors.map((error) => ({ ...error, fileName })));
}
