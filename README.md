# docs-lint

[![Quality Gate](https://sonarcloud.io/api/project_badges/measure?project=pushkedra_docs-lint&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=pushkedra_docs-lint) [![Coverage](https://sonarcloud.io/api/project_badges/measure?project=pushkedra_docs-lint&metric=coverage)](https://sonarcloud.io/component_measures?id=pushkedra_docs-lint&metric=coverage) [![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522.18-green.svg)](https://nodejs.org/) [![TypeScript](https://img.shields.io/badge/TypeScript-6-3178c6.svg)](https://www.typescriptlang.org/) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

One command to check the markdown that people and AI agents both read: `CLAUDE.md`, skills, specifications, wikis. It runs [markdownlint](https://github.com/DavidAnson/markdownlint-cli2), an American-English spell check with [cspell](https://github.com/streetsidesoftware/cspell), a check for hard-wrapped paragraphs, which no lint rule can see, and a check that every link leads somewhere. The rules ship as a versioned package, so every repository holds the same ones and a change reaches each through one version bump.

## Install

Requires Node 22.18 or later.

```bash
npm install --save-dev --save-exact docs-lint
```

Add three files at the repository root. If it already has a markdownlint or cspell config, see [Migrating](#migrating) first.

`.markdownlint-cli2.mjs`:

```js
// @ts-check
import { withBase } from "docs-lint/markdownlint";

export default withBase({
  ignores: ["generated/**"], // this repository's exclusions, on top of the package's
});
```

The package ships types, so an editor completes and describes every option of `withBase`, and `// @ts-check` underlines a mistake as you type. `node_modules/docs-lint/dist/config/markdownlint.d.ts` is the reference for reading rather than completing. A name nothing reads is refused when the command runs, with exit 2 and the names it knows, so a typo cannot quietly leave a check without its setting.

`cspell.json`. Its `ignorePaths` applies to the command as well as to an editor's spell checker, so a path listed only there loses its spelling check alone. `ignores` covers all three checks, and repeating an exclusion here is only for the editor:

```json
{
  "version": "0.2",
  "import": ["docs-lint/cspell"],
  "dictionaryDefinitions": [{ "name": "project-words", "path": "./project-words.txt", "addWords": true }],
  "dictionaries": ["project-words"],
  "ignorePaths": ["generated/**"]
}
```

`project-words.txt`, this repository's terms, one per line. It may be empty, but it has to exist.

Keep `node_modules` in `.gitignore`. In a repository without a `package.json`, the install creates one and a lockfile: commit both, because `npm ci` needs the lockfile, and add `"private": true`.

## Run

```bash
npx docs-lint                # every markdown file in the tree, without what is gitignored
npx docs-lint --fix          # unwrap paragraphs and apply the lint fixes that only change layout
npx docs-lint README.md      # those files
npx docs-lint --staged       # the markdown staged in this commit, and tracked links into what it changes
npx docs-lint migrate        # print the config that replaces an old markdownlint config; --write applies it
```

Run it from the repository root. `"lint": "docs-lint"` under `scripts` in `package.json` makes it `npm run lint`, or `"lint:docs"` where `lint` is taken. A pre-commit hook needs one line, with `--no-install` so that it can never download anything: `npx --no-install docs-lint --staged`. In CI, install first with `npm ci`, then run `npx --no-install docs-lint`.

| Exit | Meaning |
| --- | --- |
| 0 | clean, or only spelling warnings |
| 1 | a lint finding, a broken link or a hard-wrapped paragraph |
| 2 | a check could not run: a missing config, a broken one, a rival one, an unknown option, a bad argument, a file not in UTF-8, a tool over its time limit |

The totals on the last line count hard-wrapped files, and each such file shows its first wrapped paragraph. The spell check only warns, because a proper name or a verbatim quote is flagged as readily as a misspelling. Cyrillic text is skipped, since it is another language rather than an English misspelling. A tool that runs longer than 600 seconds is stopped; `DOCS_LINT_TIMEOUT` sets another limit, in seconds.

## What it reads

In a repository, git's list decides: tracked files and untracked ones, without what is gitignored or held by a nested repository. `gitignore: false` in `withBase` reads the whole tree instead, for a repository that wants a gitignored folder linted too. A file named on the command line is read either way. `globs` in `withBase` narrows which files count as markdown, and an entry starting with `!` excludes, as `ignores` does. A named file the config excludes, or a named symlink, is skipped with a notice and exit 0, so that a hook can pass any file.

A symlink is never read or written through, so a loop cannot hang a run and `--fix` cannot change a file outside the repository. What it points at is linted as itself if it is in the repository.

## What `--fix` changes

It unwraps paragraphs and applies the lint fixes that only change layout, repeating until the text stops moving, and then reports what is left. Code, tables, frontmatter, GitHub alerts, containers, math, template tags, definition lists and `@` imports keep their line breaks. It does not apply fixes that change what the text says, such as renumbering a list, deleting an unused link definition, removing a command's `$` or making a heading of `#89`; the check still reports those for an author to decide. A bare `|` in code inside a table row is one of those: the row breaks into extra cells, and spacing that pipe would rewrite the code. `--fix` says so and leaves all the tables in that file as they are until it is written `\|`.

A file whose line breaks are its content opts out of the hard-wrap check with a line holding `<!-- markdownlint-disable hard-wrap -->`, or `<!-- markdownlint-disable -->`, which also turns the lint off. Either one covers the whole file, and a later `restore` or `enable` does not bring the check back. A verbatim record, such as an exported conversation, belongs in `ignores`, because a fix has no undo in a file git does not track.

## Links

The rule `docs-lint-links` runs with the lint, on links, images, reference definitions and HTML `href` and `src`. A template's placeholder, such as `{{name}}`, `${name}`, `<url>` or `%NAME%`, is skipped.

- **A relative link** must reach a file in its exact case, whatever the local filesystem accepts, and in a markdown file the heading its fragment names, by the name MD051 gives it.
- **From a tracked file**, it must also stay inside the repository and off gitignored paths: both resolve on the machine that wrote them and nowhere else. A target that is untracked but not ignored passes, because the same commit may add it. A repository kept beside another names it in `allowedRoots`, and links there must still resolve.
- **An external link** is checked for form only, and no request is sent: it must parse, use `http`, `https`, `mailto` or `tel`, or be an image's `data:` URL, and not match a denied pattern. The base denies `http://`, except to this machine: `localhost`, `*.localhost`, `127.0.0.1`, `0.0.0.0` and `[::1]`.
- **`--staged`** also reads the other tracked markdown for links into what the commit deletes, renames or edits, because a renamed file or heading breaks links in files the commit does not touch. It reads the working tree, as the rest of the lint does.

A repository sets its own lists in `.markdownlint-cli2.mjs`. `excludedUrls` and `deniedUrls` take a `RegExp` or a string holding one, tested against the link's destination, and an exclusion wins over a denial. `excludedSources` takes globs of files whose links are not checked, while the rest of the lint still applies to them, such as `**/assets/**` for templates whose links resolve once installed elsewhere. `allowedRoots` takes paths relative to the repository's root.

```js
export default withBase({
  config: {
    "docs-lint-links": {
      excludedUrls: [/^http:\/\/legacy\.example\.com/],
      deniedUrls: [/^https:\/\/jira\.example\.com/],
      excludedSources: ["records/**"],
      allowedRoots: ["../sibling"],
    },
  },
});
```

One link is excused with `<!-- markdownlint-disable-next-line docs-lint-links -->` above it, and `"docs-lint-links": false` turns the rule off.

## Migrating

`npx docs-lint migrate` does the config's part of step 1 and the exclusions of step 3. It reads the `.markdownlint-cli2.jsonc`, `.yaml`, or `.markdownlint.json`, `.jsonc`, `.yaml`, `.yml` at the root and prints a `.markdownlint-cli2.mjs` holding only what that config sets beyond the base, with a note on each thing worth a second look: a rule it turns off, a base setting it replaces, and `gitignore: false`, which keeps reading gitignored files as `markdownlint-cli2` does by default. `--write` creates the file and removes the old one; its comments do not move, and an existing `.markdownlint-cli2.mjs` is left alone. It refuses a config that is code (`.cjs`, `.mjs`), two configs at the root and a config with `extends`, and it names but does not touch a nested config or a spell-check config.

1. Replace, do not add: remove `.markdownlint-cli2.jsonc`, `.markdownlint.json`, `.cspell.json` and the like, and rewrite an existing `cspell.json` as shown above. A rival config would silently win, so the command refuses to run beside one. A nested copy stops the run too; if it is a template or a fixture, name it in `ignores`. A link to a config you removed is now a finding.
2. Remove direct pins of `markdownlint-cli2` and `cspell`, and point a hook at `npx --no-install docs-lint --staged`. Remove what the old setup left: scripts that call the removed tools, and instructions telling people or agents to run them.
3. Name in `ignores` what should not be linted, including the old config's exclusions: the base excludes only `.git`, `node_modules`, `.idea` and `.vscode`, so generated or installed markdown, such as `.claude/skills`, is linted until it is named. Saved web pages and verbatim exports belong there too.
4. Run it and expect a lot on a repository that has never been linted to these rules. `--fix` clears most layout findings; review its `git diff` before committing. `--staged` then holds each file to the rules as it is next edited.

## What belongs where

The package holds what is true of any repository: the rules, the British forms American English refuses, the terms no dictionary knows. **It is public, so a client's name, a product's term or a private path never goes into it.** Everything that belongs to one repository stays in that repository's three files:

- an exclusion goes into `ignores`, and into `ignorePaths` too if an editor's spell checker should honor it;
- a link's exclusion goes into `docs-lint-links`;
- a term goes into `project-words.txt`;
- a word this package forbids that is correct here, such as `licence` as a product's term, goes into `ignoreWords` in `cspell.json`.

## Updating

Pin an exact version. A new rule then reaches a repository when its bump is reviewed, not everywhere at once. [CHANGELOG.md](CHANGELOG.md) says what each version changes.

## Contributing

After `npm ci`, `npm run setup:hooks` turns on the pre-commit hook in `.githooks/`. It is a separate step so that the published package carries no script that touches a consumer's git config.

## License

[MIT](LICENSE)
