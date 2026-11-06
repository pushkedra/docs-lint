// The markdown lint's rules and exclusions. A repository takes them through `withBase`, in its own
// `.markdownlint-cli2.mjs`. JavaScript rather than JSONC there, because `extends` carries a config's
// rules but not its `ignores`, and a repository has to add exclusions without losing these.

import { LINKS_RULE, linksRule } from "../links.ts";

/** Options of the `docs-lint-links` rule, set under `config` in `withBase`. */
export interface LinkOptions {
  /** Link destinations not to check, and allowed past a denial, such as `/^http:\/\/legacy\.example\.com/`. */
  excludedUrls?: (RegExp | string)[];
  /** External URLs to refuse, on top of the base's plain `http://`, such as `/^https:\/\/jira\.example\.com/`. */
  deniedUrls?: (RegExp | string)[];
  /** Globs of files whose links are not checked, while the rest of the lint still applies to them. */
  excludedSources?: string[];
  /** Paths outside the repository, relative to its root, that tracked files may link into, such as `../sibling`. Those links must still resolve. */
  allowedRoots?: string[];
}

/**
 * What a repository passes to `withBase`. Anything else is refused, because a misspelled option would
 * otherwise be ignored without a word.
 */
export interface BaseOptions {
  /** Lint rules on top of the base's, by name, and the options of `docs-lint-links`. `false` turns a rule off. */
  config?: { "docs-lint-links"?: LinkOptions | false; [rule: string]: unknown };
  /** Globs to exclude from all three checks, on top of the base's `.git`, `node_modules`, `.idea` and `.vscode`. */
  ignores?: string[];
  /** Which files count as markdown. Default `["**\/*.md"]`. */
  globs?: string[];
  /** Whether what is gitignored is left out. Default `true`; `false` reads the whole tree, for a repository that lints a gitignored folder too. */
  gitignore?: boolean | string;
  /** More markdownlint rules, beside the base's. */
  customRules?: unknown[];
  /** A markdownlint-cli2 option. `docs-lint --fix` is the way to fix. */
  fix?: boolean;
  /** A markdownlint-cli2 option: the pattern that recognizes frontmatter. */
  frontMatter?: string;
  /** A markdownlint-cli2 option. */
  markdownItPlugins?: unknown[];
  /** A markdownlint-cli2 option. */
  modulePaths?: string[];
  /** A markdownlint-cli2 option. Default `true` here. */
  noBanner?: boolean;
  /** A markdownlint-cli2 option: ignore `markdownlint-disable` comments. */
  noInlineConfig?: boolean;
  /** A markdownlint-cli2 option. Default `true` here. */
  noProgress?: boolean;
  /** A markdownlint-cli2 option. The command's totals read its default format. */
  outputFormatters?: unknown[];
  /** A markdownlint-cli2 option. */
  overrides?: unknown[];
  /** A markdownlint-cli2 option. */
  showFound?: boolean;
}

const OPTIONS = [
  "config", "ignores", "globs", "gitignore", "customRules", "fix", "frontMatter", "markdownItPlugins",
  "modulePaths", "noBanner", "noInlineConfig", "noProgress", "outputFormatters", "overrides", "showFound",
];
const LINK_LISTS = ["excludedUrls", "deniedUrls", "excludedSources", "allowedRoots"];

const unknownOption = (name: string, known: string[]) => new Error(`unknown option ${name}; known: ${known.join(", ")}`);

/** Refuse a name nothing reads: a typo would otherwise leave a check running as if it were configured. */
function assertKnown(options: BaseOptions): void {
  for (const name of Object.keys(options)) if (!OPTIONS.includes(name)) throw unknownOption(name, OPTIONS);
  for (const name of Object.keys(options.config ?? {})) {
    if (name !== LINKS_RULE && name.toLowerCase().startsWith("docs-lint")) throw unknownOption(name, [LINKS_RULE]);
  }
  const links: unknown = options.config?.[LINKS_RULE];
  if (links === undefined || links === false || links === true) return;
  for (const [name, value] of Object.entries(links as object)) {
    if (!LINK_LISTS.includes(name)) throw unknownOption(`${name} of ${LINKS_RULE}`, LINK_LISTS);
    if (!Array.isArray(value)) throw new Error(`${name} of ${LINKS_RULE} must be an array`);
  }
}

const base = {
  customRules: [linksRule],

  config: {
    default: true,

    // Every rule is on at its default unless it is named below, and none is off for taste.

    // A tab in code is content, and the rule's fix would turn it into a space: a Makefile stops working.
    MD010: { code_blocks: false },

    // A repeated heading under another parent is ordinary structure: each page of a set has its `Usage`.
    MD024: { siblings_only: true },

    // --- the point of this file --------------------------------------------
    // A paragraph is one line. Hard-wrapped prose reads worse on a narrow screen outside a
    // rendered preview, where the column width changes from paragraph to paragraph, and it
    // diffs worse: editing two words of one sentence shows as the one line it is, not as every
    // wrapped line the edit touched. `lib/reflow.mjs` folds the other way.
    MD013: false, // line-length

    // Without this the rule counts a frontmatter `title:` as the document's first h1 and then
    // flags the real one.
    MD025: { front_matter_title: "" },

    // --- narrowed, not off ---------------------------------------------------
    // MD033 is on with an allowlist rather than off. A bare `<placeholder>` whose name parses
    // as a tag is emitted as raw HTML and disappears from the rendered page — `<precondition>`
    // renders as nothing, `[<title>](<url>)` as an empty link. A multi-word placeholder like
    // `<what is broken — 2-3 sentences>` escapes instead and is fine, which is why the failure
    // goes unnoticed. The allowlist holds the elements worth writing by hand, plus the parts that
    // only work inside another — `summary` in `details`, `rt` and `rp` in `ruby`; anything else
    // is a deliberate decision, not an accident.
    MD033: {
      allowed_elements: [
        "a", "br", "u", "sub", "sup", "kbd", "img", "details", "summary",
        // Inline semantics markdown has no syntax for: a highlight, a reading annotated above
        // its word, a term at its definition, an abbreviation with its expansion, a run of
        // opposite-direction script kept from reordering its neighbors, a work's title, an
        // inline quotation, fine print.
        "mark", "ruby", "rt", "rp", "dfn", "abbr", "bdi", "cite", "q", "small",
      ],
    },

    // The valid styles are "any" (the default), "aligned", "compact" and "tight" — anything else
    // is dropped by the schema without a word, and the rule then silently does nothing.
    // "compact" is the one --fix can always reach: "aligned" needs column padding it cannot add.
    // The fix keeps whatever dash width a separator row already had, so a long `|------|` row
    // stays long; write separators as `---`.
    MD060: { style: "compact" },
  },

  // The command takes its file list from these: `globs` says which files are markdown, `gitignore`
  // whether git's list decides what is in the tree, and a repository may turn it off to lint a
  // gitignored folder too. The two output settings are off because the command prints its own totals.
  globs: ["**/*.md"],
  gitignore: true,
  noBanner: true,
  noProgress: true,

  // Exclusions go here rather than as negated globs: `ignores` also applies to files named on
  // the command line, so linting only the staged files with --no-globs still skips them. A negated
  // glob is dropped together with the globs it sits in. `config/cspell.json` cannot read this list
  // and repeats it.
  ignores: [
    "**/.git/**",
    "**/node_modules/**",
    ".idea/**",
    ".vscode/**",
  ],
};

// Their fixes change what the text says rather than how it is laid out: a list restarted after an
// image is renumbered, a marker that is a diff's `+` becomes `-`, a colon goes from a heading, the spaces
// go from a code span, an unused definition is deleted. `--fix` leaves them, and the check still reports.
const LEFT_TO_THE_AUTHOR = Object.fromEntries(
  ["MD004", "MD026", "MD029", "MD037", "MD038", "MD049", "MD050", "MD053"].map((rule) => [rule, false] as const),
);

/** The base with a repository's own settings on top: its rules win, its exclusions add. */
export function withBase(options: BaseOptions = {}): BaseOptions {
  assertKnown(options);
  const { config, ignores = [], customRules = [], ...rest } = options;
  return {
    ...base,
    ...rest,
    customRules: [...base.customRules, ...customRules],
    config: { ...base.config, ...config, ...(process.env.DOCS_LINT_FIX_PASS ? LEFT_TO_THE_AUTHOR : {}) },
    ignores: [...base.ignores, ...ignores],
  };
}
