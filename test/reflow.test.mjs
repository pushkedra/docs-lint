/**
 * Tests for lib/reflow.mjs.
 *
 * The tool folds hard-wrapped paragraphs onto one line, and the way it fails is by
 * folding something that is not a paragraph. So the coverage here is a fixture of
 * the constructs that are easy to get wrong, checked against a golden output, plus
 * one assertion per construct saying in words what must survive.
 *
 * Several of these may not occur in any file yet. They are here because a tool
 * that only works on the corpus it was written against will break the first time
 * someone writes an ordinary thing it has not seen — a fenced block inside a
 * blockquote is exactly that case.
 *
 * Run: node --test test/reflow.test.mjs
 */

import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { withBase } from "../config/markdownlint.mjs";
import { listFiles } from "../lib/files.mjs";
import { firstWrappedLine, ignoredBy, reflow, reflowFiles } from "../lib/reflow.mjs";

// A two-space hard break is a line break the author asked for, and it is the one
// piece of this fixture that trailing-whitespace tooling would silently destroy.
// It is written as a marker and substituted in, so the source file carries no
// trailing whitespace of its own.
const SP = "<SP>";

const text = (raw) => raw.replaceAll(SP, " ");

const HAZARDS = text(
  `> ### Backend never consumes the design. Never.
>
> Backend works from the BA artifacts alone. A UI mockup is not a requirement: building the API around
> a screen layout couples the contract to a visual decision that will change, and substitutes a
> designer's inference for the BA's stated requirement. **Something present only in the design and not
> in the ACs is a gap in the ACs** — send it back to the BA rather than implementing it.

Two paragraphs inside one quote, split by a bare marker:

> First paragraph of the quote, wrapped
> across two lines.
>
> Second paragraph, also wrapped
> across two lines.

A fenced block inside a quote:

> Intro line that is wrapped
> onto a second line.
>
> \`\`\`python
> def f():
>     return 1
> \`\`\`
>
> Closing line wrapped
> onto two lines.

Nested quote levels:

> Outer quote wrapped
> onto two lines.
>
> > Inner quote wrapped
> > onto two lines.

A list inside a quote:

> Lead-in wrapped
> onto two lines.
>
> - first item wrapped
>   onto two lines
> - second item

Lazy continuation (no marker on the second line):

> Quoted line one
lazily continued line two

A fence with an info string nested in a list:

1. Step one, wrapped
   onto two lines.

   \`\`\`tf
   module "x" {
     source = "y"
   }
   \`\`\`

2. Step two.

Setext heading below a wrapped paragraph:

This heading text is wrapped
across two physical lines
===

Hard break: this line ends with two spaces${SP}${SP}
so it must stay a separate line.

Indented code block:

    not prose
    still not prose

Thematic break right after a paragraph:

Paragraph text wrapped
onto two lines.

---

Table immediately after a paragraph line:

Paragraph before a table
| a | b |
|---|---|
| 1 | 2 |

Preformatted HTML right after a paragraph:

<pre>
line one
line two
</pre>

A multi-line HTML comment carrying a template:

<!--
### <date> · <repo>
**Found:** <what>
**Caught by:** <check>
-->

[ref]: https://example.com
`,
);

const EXPECTED = text(
  `> ### Backend never consumes the design. Never.
>
> Backend works from the BA artifacts alone. A UI mockup is not a requirement: building the API around a screen layout couples the contract to a visual decision that will change, and substitutes a designer's inference for the BA's stated requirement. **Something present only in the design and not in the ACs is a gap in the ACs** — send it back to the BA rather than implementing it.

Two paragraphs inside one quote, split by a bare marker:

> First paragraph of the quote, wrapped across two lines.
>
> Second paragraph, also wrapped across two lines.

A fenced block inside a quote:

> Intro line that is wrapped onto a second line.
>
> \`\`\`python
> def f():
>     return 1
> \`\`\`
>
> Closing line wrapped onto two lines.

Nested quote levels:

> Outer quote wrapped onto two lines.
>
> > Inner quote wrapped
> > onto two lines.

A list inside a quote:

> Lead-in wrapped onto two lines.
>
> - first item wrapped
>   onto two lines
> - second item

Lazy continuation (no marker on the second line):

> Quoted line one
lazily continued line two

A fence with an info string nested in a list:

1. Step one, wrapped onto two lines.

   \`\`\`tf
   module "x" {
     source = "y"
   }
   \`\`\`

2. Step two.

Setext heading below a wrapped paragraph:

This heading text is wrapped across two physical lines
===

Hard break: this line ends with two spaces${SP}${SP}
so it must stay a separate line.

Indented code block:

    not prose
    still not prose

Thematic break right after a paragraph:

Paragraph text wrapped onto two lines.

---

Table immediately after a paragraph line:

Paragraph before a table
| a | b |
|---|---|
| 1 | 2 |

Preformatted HTML right after a paragraph:

<pre>
line one
line two
</pre>

A multi-line HTML comment carrying a template:

<!--
### <date> · <repo>
**Found:** <what>
**Caught by:** <check>
-->

[ref]: https://example.com
`,
);

describe("golden", () => {
  test("fixture matches expected", () => {
    assert.equal(reflow(HAZARDS), EXPECTED);
  });

  test("is idempotent", () => {
    const once = reflow(HAZARDS);
    assert.equal(reflow(once), once);
  });

  test("already unwrapped text is untouched", () => {
    const source = "One paragraph on one line.\n\nAnother one.\n";
    assert.equal(reflow(source), source);
  });
});

// A hard break on the last line of a folded run must outlive the fold. Lose it
// and the next pass joins across it, so the tool changes a file it has already
// reflowed.
describe("hard break after a fold", () => {
  const CASES = {
    paragraph: [`first\nsecond${SP}${SP}\nthird\n`, `first second${SP}${SP}\nthird\n`],
    "list item": [`- first\n  second${SP}${SP}\n  third\n`, `- first second${SP}${SP}\n  third\n`],
    blockquote: [`> first\n> second${SP}${SP}\n> third\n`, `> first second${SP}${SP}\n> third\n`],
  };

  test("the break is kept", () => {
    for (const [name, [source, expected]] of Object.entries(CASES)) {
      assert.equal(reflow(text(source)), text(expected), name);
    }
  });

  test("one pass reaches the fixed point", () => {
    for (const [name, [source]] of Object.entries(CASES)) {
      const once = reflow(text(source));
      assert.equal(reflow(once), once, name);
    }
  });
});

// One assertion per construct, each naming what folding it would destroy.
describe("what must survive", () => {
  const out = reflow(HAZARDS);

  test("paragraphs are folded", () => {
    assert.ok(out.includes("wrapped across two lines."));
    assert.ok(!out.includes("Paragraph text wrapped\nonto two lines."));
  });

  test("fenced code keeps its line breaks", () => {
    assert.ok(out.includes('   ```tf\n   module "x" {\n     source = "y"\n   }\n   ```'));
  });

  test("fenced code inside a blockquote keeps its line breaks", () => {
    assert.ok(out.includes("> ```python\n> def f():\n>     return 1\n> ```"));
  });

  test("a bare marker still separates two quoted paragraphs", () => {
    assert.ok(
      out.includes(
        "> First paragraph of the quote, wrapped across two lines.\n>\n" +
          "> Second paragraph, also wrapped across two lines.",
      ),
    );
  });

  test("a heading inside a blockquote is not folded into the prose", () => {
    assert.ok(out.includes("> ### Backend never consumes the design. Never.\n>\n"));
  });

  test("a two-space hard break survives", () => {
    assert.ok(out.includes(text(`ends with two spaces${SP}${SP}\nso it must stay`)));
  });

  test("a table is untouched", () => {
    assert.ok(out.includes("| a | b |\n|---|---|\n| 1 | 2 |"));
  });

  test("a paragraph is not folded into the table below it", () => {
    assert.ok(out.includes("Paragraph before a table\n| a | b |"));
  });

  test("a setext underline stays on its own line", () => {
    assert.ok(out.includes("This heading text is wrapped across two physical lines\n==="));
  });

  test("a thematic break stays on its own line", () => {
    assert.ok(out.includes("Paragraph text wrapped onto two lines.\n\n---"));
  });

  test("an indented code block keeps its line breaks", () => {
    assert.ok(out.includes("    not prose\n    still not prose"));
  });

  test("a link reference definition is untouched", () => {
    assert.ok(out.trimEnd().endsWith("[ref]: https://example.com"));
  });

  test("a nested quote level ends the run", () => {
    assert.ok(out.includes("> > Inner quote wrapped\n> > onto two lines."));
  });

  test("a list inside a quote ends the run", () => {
    assert.ok(out.includes("> - first item wrapped\n>   onto two lines"));
  });

  test("a pre block keeps its line breaks", () => {
    assert.ok(out.includes("<pre>\nline one\nline two\n</pre>"));
  });

  test("an html comment keeps its line breaks", () => {
    assert.ok(
      out.includes("<!--\n### <date> · <repo>\n**Found:** <what>\n**Caught by:** <check>\n-->"),
    );
  });
});

describe("frontmatter", () => {
  test("is copied through untouched", () => {
    const out = reflow(
      "---\n" +
        "title: something\n" +
        "description: a value\n" +
        "  that looks wrapped\n" +
        "---\n" +
        "\n" +
        "Body text wrapped\n" +
        "over two lines.\n",
    );
    assert.ok(out.includes("description: a value\n  that looks wrapped\n---"));
    assert.ok(out.includes("Body text wrapped over two lines."));
  });
});

const WRAPPED = "Wrapped\nover two lines.\n";

// Each test gets its own directory under the system temp dir, removed afterwards.
function withTree(names, body) {
  const root = mkdtempSync(join(tmpdir(), "reflow-test-"));
  try {
    for (const name of names) {
      const path = join(root, name);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, WRAPPED, "utf8");
    }
    body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("reflowFiles", () => {
  test("check mode reports without writing, then a rewrite fixes it", () => {
    withTree(["a.md"], (root) => {
      const path = join(root, "a.md");
      const ignored = ignoredBy(root, []);

      assert.deepEqual(reflowFiles([path], { check: true, ignored }), [path]);
      assert.equal(readFileSync(path, "utf8"), WRAPPED);

      assert.deepEqual(reflowFiles([path], { check: false, ignored }), [path]);
      assert.equal(readFileSync(path, "utf8"), "Wrapped over two lines.\n");

      assert.deepEqual(reflowFiles([path], { check: true, ignored }), []);
    });
  });
});

// Run against the shipped list itself: its globs end in `/**`, which a glob
// translator that does not know about the trailing form would get wrong.
describe("ignores", () => {
  const ignores = withBase({ ignores: [".claude/skills/**", ".github/**"] }).ignores;

  test("an ignored file is skipped", () => {
    withTree([".claude/skills/x/SKILL.md"], (root) => {
      const path = join(root, ".claude/skills/x/SKILL.md");
      const ignored = ignoredBy(root, ignores);
      assert.deepEqual(reflowFiles([path], { check: true, ignored }), []);
      assert.deepEqual(reflowFiles([path], { check: false, ignored }), []);
      assert.equal(readFileSync(path, "utf8"), WRAPPED);
    });
  });

  test("a file outside the ignores is still checked", () => {
    withTree([".claude/skills/x/SKILL.md", "docs/a.md", ".claude/rules/b.md"], (root) => {
      const paths = [".claude/skills/x/SKILL.md", "docs/a.md", ".claude/rules/b.md"].map((name) =>
        join(root, name),
      );
      const changed = reflowFiles(paths, { check: true, ignored: ignoredBy(root, ignores) });
      assert.deepEqual(changed, [join(root, "docs/a.md"), join(root, ".claude/rules/b.md")]);
    });
  });

  test("a leading double star reaches into dot directories", () => {
    const ignored = ignoredBy("/repo", ignores);
    assert.equal(ignored(".tools/pkg/node_modules/dep/README.md"), true);
  });

  test("a trailing double star covers every depth below its directory", () => {
    const ignored = ignoredBy("/repo", ignores);
    assert.equal(ignored(".github/a.md"), true);
    assert.equal(ignored(".github/workflows/deep/a.md"), true);
    assert.equal(ignored("docs/a.md"), false);
  });

  test("the path is matched however it is spelled", () => {
    withTree([".github/a.md"], (root) => {
      const ignored = ignoredBy(root, ignores);
      for (const name of ["./.github/a.md", join(root, ".github/a.md"), "docs/../.github/a.md"]) {
        assert.equal(ignored(name), true, name);
      }
    });
  });

  test("with no ignores every file is checked", () => {
    withTree([".github/a.md"], (root) => {
      const path = join(root, ".github/a.md");
      assert.deepEqual(reflowFiles([path], { check: true, ignored: ignoredBy(root, []) }), [path]);
    });
  });
});

describe("listFiles, outside a repository", () => {
  const none = () => false;
  const walk = (root, ignored = none) => listFiles(root, { gitignore: false, ignored });

  test("finds what is in a dot directory", () => {
    withTree([".hidden/a.md", "b.md"], (root) => {
      assert.deepEqual(walk(root), [".hidden/a.md", "b.md"]);
    });
  });

  test("does not follow a symlink, to a directory or a file, in or out of the tree", () => {
    withTree(["real/a.md"], (root) => {
      withTree(["far/b.md"], (other) => {
        symlinkSync(join(root, "real"), join(root, "inside"));
        symlinkSync(join(other, "far"), join(root, "outside"));
        symlinkSync(join(root, "real/a.md"), join(root, "file.md"));
        assert.deepEqual(walk(root), ["real/a.md"]);
      });
    });
  });

  test("survives a symlink loop and a dangling symlink", () => {
    withTree(["sub/a.md"], (root) => {
      symlinkSync(root, join(root, "sub/back"));
      symlinkSync(join(root, "missing"), join(root, "dangling"));
      symlinkSync(join(root, "self.md"), join(root, "self.md"));
      assert.deepEqual(walk(root), ["sub/a.md"]);
    });
  });

  test("skips .git, node_modules and another repository nested inside", () => {
    withTree([".git/a.md", "node_modules/b.md", "sub/node_modules/c.md", "d.md", "nested/.git/config", "nested/e.md"], (root) => {
      assert.deepEqual(walk(root), ["d.md"]);
    });
  });

  test("honors ignored, however the directory is spelled", () => {
    withTree(["keep/a.md", "skip/b.md", "skip/deep/c.md", "gen/d.md", "out/e.md"], (root) => {
      assert.deepEqual(walk(root, ignoredBy(root, ["skip/**", "gen/", "./out/**"])), ["keep/a.md"]);
    });
  });

  test("returns sorted names", () => {
    withTree(["z.md", "b/y.md", "a.md", "b/a.md"], (root) => {
      assert.deepEqual(walk(root), ["a.md", "b/a.md", "b/y.md", "z.md"]);
    });
  });
});

describe("what a fold must not corrupt", () => {
  test("frontmatter after a byte-order mark is kept, and so is the mark", () => {
    const text = "\uFEFF---\ndescription: >\n  one\n  two\n---\n\nOne line\nof a paragraph.\n";
    assert.equal(reflow(text), "\uFEFF---\ndescription: >\n  one\n  two\n---\n\nOne line of a paragraph.\n");
  });

  test("CRLF keeps a hard break and its line endings", () => {
    assert.equal(reflow("foo  \r\nbar\r\nbaz\r\n"), "foo  \r\nbar baz\r\n");
    assert.equal(reflow("foo\\\r\nbar\r\n"), "foo\\\r\nbar\r\n");
  });

  test("a file with nothing to fold comes back as it was, mixed endings included", () => {
    const text = "# Title\r\n\nOne line.\n";
    assert.equal(reflow(text), text);
  });

  test("tab-indented code is not prose", () => {
    const text = "\tcode one\n\tcode two\n";
    assert.equal(reflow(text), text);
    assert.equal(reflow("Text\n\tcode\n"), "Text\n\tcode\n");
  });

  test("a table with no leading pipes is not prose", () => {
    const text = "a | b\n--- | ---\n1 | 2\n3 | 4\n";
    assert.equal(reflow(text), text);
    assert.equal(reflow("Before\nlines\na | b\n:--- | ---:\n1 | 2\n"), "Before lines\na | b\n:--- | ---:\n1 | 2\n");
  });

  const unchanged = (name, text) => test(name, () => assert.equal(reflow(text), text));

  unchanged("a fence opened on a list marker", "- ```js\n  a\n  b\n  ```\n");
  unchanged("a fence opened on a numbered marker", "1. ```\n   a\n   b\n   ```\n");
  unchanged("a GitHub alert's marker", "> [!NOTE]\n> Text.\n");
  unchanged("TOML frontmatter", "+++\ntitle = \"x\"\nlist = [\n  1,\n  2,\n]\n+++\n\n# T\n");
  unchanged("JSON frontmatter", "{\n  \"a\": 1,\n  \"b\": 2\n}\n\n# T\n");
  unchanged("a container", ":::note\nText.\n:::\n");
  unchanged("display math", "$$\na = b\nc = d\n$$\n");
  unchanged("a definition list", "Term\n: One.\n: Two.\n");
  unchanged("template tags", "{{#if x}}\nText.\n{{/if}}\n\n{% if x %}\nText.\n{% endif %}\n");
  unchanged("a run of imports", "@a.md\n@b.md\n");
  unchanged("a table with no leading pipes in a blockquote", "> a | b\n> --- | ---\n> 1 | 2\n> 3 | 4\n");
  unchanged("a table with no leading pipes on a list marker", "- a | b\n  --- | ---\n  1 | 2\n  3 | 4\n");
  unchanged("a file that opts out with the lint's own comment", "<!-- markdownlint-disable -->\n\nOne\ntwo\n");
  unchanged("a file that opts out of this check alone", "<!-- markdownlint-disable hard-wrap -->\n\nOne\ntwo\n");

  test("a quoted comment does not opt a file out", () => {
    assert.equal(reflow("Use `<!-- markdownlint-disable -->` here\nand there.\n"), "Use `<!-- markdownlint-disable -->` here and there.\n");
  });

  test("a long run of spaces takes linear time", () => {
    const started = Date.now();
    reflow(`a${" ".repeat(200_000)}b\nc\n`);
    assert.ok(Date.now() - started < 2000);
  });

  test("the first line a fold would change is named", () => {
    assert.equal(firstWrappedLine("# T\n\nOne\ntwo\n"), 3);
    assert.equal(firstWrappedLine("# T\n\nOne two\n"), null);
  });
});
