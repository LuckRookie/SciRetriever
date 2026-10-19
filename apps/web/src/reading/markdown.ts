import { Marked, type Token } from "marked";
import katex from "katex";
import { escape as e } from "./dom.js";

const math = (text: string, displayMode: boolean) =>
  katex.renderToString(text, {
    displayMode,
    trust: false,
    strict: "error",
    throwOnError: false,
    maxExpand: 1000,
    maxSize: 20,
  });
/** No remote media or raw HTML. Resource placeholders are filled only by the document owner. */
function createMarkdown(allowFragments: boolean) {
  return new Marked({
    gfm: true,
    renderer: {
      html: ({ text }) => e(text),
      image: ({ href, text }) =>
        `<span class="reading-resource" data-resource="${e(href)}">图片：${e(text || href)}</span>`,
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
        start: (s) => s.indexOf("$$"),
        tokenizer(s) {
          const m = /^\$\$\s*\n?([\s\S]+?)\$\$(?:\n|$)/.exec(s);
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
}
export const markdown = createMarkdown(false);
/** Only the fixed-document owner wires and validates these fragment links. */
export const documentMarkdown = createMarkdown(true);

/** Marked normalizes CRLF. Map its UTF-16 token boundaries back to original UTF-8. */
export function markdownBlocks(
  original: string,
): { token: Token; start: number; end: number }[] {
  let normalized = "",
    bytes = 0;
  const positions: number[] = [0],
    encoder = new TextEncoder();
  for (let i = 0; i < original.length; ) {
    const c = String.fromCodePoint(original.codePointAt(i)!);
    if (c === "\r") {
      const count = original[i + 1] === "\n" ? 2 : 1;
      normalized += "\n";
      bytes += count;
      positions.push(bytes);
      i += count;
    } else {
      normalized += c;
      for (let n = 1; n < c.length; n++) positions.push(bytes);
      bytes += encoder.encode(c).length;
      positions.push(bytes);
      i += c.length;
    }
  }
  let offset = 0;
  return markdown.lexer(normalized).map((token) => {
    const start = positions[offset]!;
    offset += token.raw.length;
    return { token, start, end: positions[offset]! };
  });
}
