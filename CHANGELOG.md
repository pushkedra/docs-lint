# Changelog

All notable changes to this package are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the package follows [Semantic Versioning](https://semver.org/). A new or tightened rule is at least a minor release, because it can fail a build that passed before.

## [Unreleased]

### Added

- `docs-lint migrate` prints a `.markdownlint-cli2.mjs` holding what the markdownlint config at the root sets beyond the base, and `--write` creates that file and removes the old config. It reads JSON, JSONC and YAML, and refuses a config that is code.

### Fixed

- On Windows, a repository with enough markdown files to pass the command-line limit exited 2 with no reason given. The file list no longer goes through a command line, on any platform.

## [0.1.0] - 2026-11-06

### Added

- `docs-lint` command: markdownlint, an American-English spell check, a hard-wrap check and a link check, with `--fix`, `--staged` and explicit file arguments, over one file list that honors `.gitignore` and never follows a symlink.
- `docs-lint/markdownlint` export: a shared markdownlint config and the `withBase` helper, with types that describe each option, and a refusal of any option it does not know.
- `docs-lint/cspell` export: a shared cspell config with a dictionary that forbids British spellings.
- `docs-lint-links` rule: relative links, fragments in other files, tracked links out of the repository or into gitignored paths, and the form of external links.
