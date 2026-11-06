/** What the link rule reads from markdownlint's parsed tokens. */

import { readFileSync } from "node:fs";
import type { MicromarkToken, Rule } from "markdownlint";
import { lint } from "markdownlint/sync";
import { cached } from "./cache.ts";

export interface Link {
  lineNumber: number;
  destination: string;
}

// `<url>` is the placeholder form, where a real path has a dot or a slash: `<my file.md>`.
const PATHLESS = /^[^./]*$/;
const NAMED_REFERENCES = new Map([["amp", "&"], ["lt", "<"], ["gt", ">"], ["quot", "\""], ["apos", "'"]]);
const HTML_LINK = /\s(?:href|src)\s*=\s*["']([^"']+)["']/gi;
const HTML_ID = /\sid\s*=\s*["']?([^"'\s>]+)/i;
const HTML_NAME = /^<a\s(?:[^>]*\s)?name\s*=\s*["']?([^"'\s>]+)/i;
const HEADING_ANCHOR = /\{#([a-z\d]+(?:[-_]+[a-z\d]+)*)\}/gu;
const SLUG_DROPS = /[^\p{Letter}\p{Mark}\p{Number}\p{Connector_Punctuation}\- ]/gu;

const walk = (tokens: MicromarkToken[], visit: (token: MicromarkToken) => void): void => {
  for (const token of tokens) {
    visit(token);
    walk(token.children, visit);
  }
};

const referenceValue = (text: string): string => {
  const [, hex = "", decimal = "", name = ""] = /^&(?:#[xX]([\da-fA-F]+)|#(\d+)|(\w+));$/.exec(text) ?? [];
  if (hex || decimal) return String.fromCodePoint(hex ? Number.parseInt(hex, 16) : Number(decimal));
  return NAMED_REFERENCES.get(name) ?? text;
};

/** A destination as it means, with its backslash escapes and character references resolved. */
const plainText = (token: MicromarkToken): string =>
  token.children
    .map((child) => {
      if (child.type === "data" || child.type === "characterEscapeValue") return child.text;
      return child.type === "characterReference" ? referenceValue(child.text) : plainText(child);
    })
    .join("");

/** Every link in the parsed file: what it points at and where it was written. */
export function linksIn(tokens: MicromarkToken[]): Link[] {
  const links: Link[] = [];
  walk(tokens, (token) => {
    const { type, startLine: lineNumber, text } = token;
    if (type === "resourceDestinationString" || type === "definitionDestinationString") {
      const destination = plainText(token);
      if (token.parent?.type.endsWith("DestinationLiteral") && PATHLESS.test(destination)) return;
      links.push({ lineNumber, destination });
    } else if (type === "autolinkProtocol") {
      links.push({ lineNumber, destination: text });
    } else if (type === "htmlText" && !text.startsWith("<!--")) {
      for (const [, destination] of text.matchAll(HTML_LINK)) links.push({ lineNumber, destination });
    }
  });
  return links;
}

/**
 * The fragments a markdown file answers to, by the rules MD051 applies inside one file, so that a
 * heading is reachable by the same name from its own file and from any other.
 */
function anchorsIn(tokens: MicromarkToken[]): Set<string> {
  const anchors = new Set(["top"]);
  const counts = new Map<string, number>();
  const slug = (heading: MicromarkToken): string => {
    const parts: string[] = [];
    const collect = (token: MicromarkToken): void => {
      if (["characterEscapeValue", "codeTextData", "data", "mathTextData"].includes(token.type)) parts.push(token.text);
      if (!["image", "reference", "resource"].includes(token.type)) token.children.forEach(collect);
    };
    heading.children.forEach(collect);
    return parts.join("").toLowerCase().replace(SLUG_DROPS, "").replace(/ /gu, "-");
  };
  walk(tokens, (token) => {
    if (token.type === "atxHeadingText" || token.type === "setextHeadingText") {
      const name = slug(token);
      if (!name) return;
      const count = counts.get(name) ?? 0;
      counts.set(name, count + 1);
      anchors.add(count ? `${name}-${count}` : name);
      for (const [, anchor] of token.text.matchAll(HEADING_ANCHOR)) anchors.add(anchor);
    } else if (token.type === "htmlText" && !token.text.startsWith("<!--") && !token.text.startsWith("</")) {
      const match = HTML_ID.exec(token.text) ?? HTML_NAME.exec(token.text);
      if (match) anchors.add(match[1]);
    }
  });
  return anchors;
}

/** The anchors of the file at `path`, read through the parser the rule itself runs on. */
export const anchorsOf = (path: string): Set<string> =>
  cached("anchors", path, () => {
    let anchors = new Set<string>();
    const capture: Rule = {
      names: ["docs-lint-anchors"],
      description: "Collect the anchors of a link's target",
      tags: ["links"],
      parser: "micromark",
      function: ({ parsers }) => {
        anchors = anchorsIn(parsers.micromark.tokens);
      },
    };
    lint({
      strings: { [path]: readFileSync(path, "utf8") },
      config: { "default": false, "docs-lint-anchors": true },
      customRules: [capture],
    });
    return anchors;
  });
