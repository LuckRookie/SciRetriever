import { Marked, type Token } from "marked";
import katex from "katex";
import { escape as e, imagePlaceholder } from "./dom.js";
import { renderTable } from "./table.js";

const math = (text: string, displayMode: boolean) =>
  katex.renderToString(text, {
    displayMode,
    trust: false,
    // Parsed text puts plain Unicode in formulas (“177–178^{\circ}C”): drawn
    // as it is rather than as a red error; anything else stays strict.
    strict: (code: string) =>
      code === "unknownSymbol" || code === "unicodeTextInMathMode"
        ? "ignore"
        : "error",
    throwOnError: false,
    maxExpand: 1000,
    maxSize: 20,
  });
/** Raw markup is escaped except for rebuilt table structure. Media are filled only by the document owner. */
function createMarkdown(allowFragments: boolean) {
  const instance: Marked = new Marked({
    gfm: true,
    renderer: {
      html: ({ text }) =>
        renderTable(text, (value) =>
          instance.parseInline(value, { async: false }),
        ) ?? e(text),
      image: ({ href, text }) => imagePlaceholder(href, text),
      link({ href, tokens }) {
        const label = this.parser.parseInline(tokens);
        if (allowFragments && href.startsWith("#") && href.length > 1)
          return `<a href="${e(href)}" data-reading-fragment="${e(href.slice(1))}">${label}</a>`;
        if (!/^(https?:|mailto:)/i.test(href)) return label;
        return `<a href="${e(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
      },
    },
    extensions: [
      {
        name: "displayMath",
        level: "block",
        // A display formula stands on its own lines: `$$` opens one only at
        // the start of a line, and it never runs across a blank line. Glued
        // inline formulas (`…C.$${}^{1}H$ NMR`) stay inline instead of
        // swallowing the text up to the next `$$`.
        start: (s) => {
          const m = /\n[ \t]*\$\$/.exec(s);
          return m ? m.index + 1 : undefined;
        },
        tokenizer(s) {
          const m = /^\$\$\s*\n?((?:(?!\n[ \t]*\n)[\s\S])+?)\$\$(?:\n|$)/.exec(
            s,
          );
          return m ? { type: "displayMath", raw: m[0], text: m[1] } : undefined;
        },
        renderer: (t) => math(String(t.text), true),
      },
      {
        name: "inlineMath",
        level: "inline",
        start: (s) => s.indexOf("$"),
        tokenizer(s) {
          const m = /^\$([^$\n]+)\$/.exec(s);
          return m ? { type: "inlineMath", raw: m[0], text: m[1] } : undefined;
        },
        renderer: (t) => math(String(t.text), false),
      },
    ],
  });
  return instance;
}
export const markdown = createMarkdown(false);
/** Only the fixed-document owner wires and validates these fragment links. */
export const documentMarkdown = createMarkdown(true);

/**
 * Marked normalizes CRLF. Map its UTF-16 token boundaries back to original
 * UTF-8, offset by `base` bytes when `original` is a suffix of a longer text.
 * `index` is the token's end as a UTF-16 index into `original`.
 */
export function markdownBlocks(
  original: string,
  base = 0,
): { token: Token; start: number; end: number; index: number }[] {
  const positions: number[] = [base],
    origins: number[] = [0];
  let bytes = base;
  for (let i = 0; i < original.length; ) {
    const code = original.charCodeAt(i);
    if (code === 13) {
      const count = original.charCodeAt(i + 1) === 10 ? 2 : 1;
      bytes += count;
      i += count;
    } else {
      const point = original.codePointAt(i)!,
        units = point > 0xffff ? 2 : 1;
      if (units === 2) {
        positions.push(bytes);
        origins.push(i + 1);
      }
      // A lone surrogate encodes as U+FFFD, three bytes, as TextEncoder does.
      bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
      i += units;
    }
    positions.push(bytes);
    origins.push(i);
  }
  let offset = 0;
  return markdown.lexer(original.replace(/\r\n?/gu, "\n")).map((token) => {
    const start = positions[offset]!;
    offset += token.raw.length;
    return { token, start, end: positions[offset]!, index: origins[offset]! };
  });
}
