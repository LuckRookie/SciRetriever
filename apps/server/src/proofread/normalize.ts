export const NORMALIZE_VERSION = "normalize-v2";
/** Units whose identities must survive compatibility normalization. */
export const UNIT_EQUIVALENTS: Readonly<Record<string, string>> = Object.freeze(
  { "℃": "°C", "℉": "°F", "‰": "‰", "%": "%", "％": "%", K: "K", μ: "μ" },
);
export interface SemanticTokens {
  readonly sequence: readonly string[];
  readonly numbers: readonly string[];
  readonly units: readonly string[];
  readonly formulas: readonly string[];
}
export function normalizeForComparison(value: string): string {
  let text = value.replace(/[℃℉‰%％Kμ]/gu, (c) => UNIT_EQUIVALENTS[c]!);
  // HTML and LaTeX script notation carry the same positions; retain the
  // role marker rather than stripping it together with formatting tags.
  text = text
    .replace(/<sup>\s*([^<>]+?)\s*<\/sup>/giu, "^{$1}")
    .replace(/<sub>\s*([^<>]+?)\s*<\/sub>/giu, "_{$1}");
  // Preserve script roles before NFKC can erase their positional meaning.
  const scripts: Readonly<Record<string, string>> = {
    "⁰": "0",
    "¹": "1",
    "²": "2",
    "³": "3",
    "⁴": "4",
    "⁵": "5",
    "⁶": "6",
    "⁷": "7",
    "⁸": "8",
    "⁹": "9",
    "⁻": "-",
    "⁺": "+",
    "₀": "0",
    "₁": "1",
    "₂": "2",
    "₃": "3",
    "₄": "4",
    "₅": "5",
    "₆": "6",
    "₇": "7",
    "₈": "8",
    "₉": "9",
    "₋": "-",
    "₊": "+",
  };
  text = text
    .replace(
      /[⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺]+/gu,
      (s) => `^{${[...s].map((c) => scripts[c]).join("")}}`,
    )
    .replace(
      /[₀₁₂₃₄₅₆₇₈₉₋₊]+/gu,
      (s) => `_{${[...s].map((c) => scripts[c]).join("")}}`,
    )
    .normalize("NFKC");
  text = text
    .replace(/[‐‑‒–—−﹘﹣]/gu, "-")
    .replace(
      /\\(?:mathrm|mathsf|mathbf|mathit|textrm|text)\s*\{([^{}]*)\}/gu,
      "$1",
    )
    .replace(/\\(?:left|right)(?=[()[\]{}|])/gu, "")
    .replace(/\\(?:,|;|!|quad\b|qquad\b)|~/gu, " ")
    .replace(/\$+/gu, "");
  text = text
    .replace(/\^\s*\{\s*\\circ\s*\}\s*C/gu, "°C")
    .replace(/\^\s*\{\s*\\circ\s*\}\s*F/gu, "°F")
    .replace(
      /([_^])\s*\{\s*([^{}]*?)\s*\}/gu,
      (_, op: string, body: string) => `${op}{${body.replace(/\s+/gu, "")}}`,
    );
  // Collapse OCR-spaced numerals only when punctuation or LaTeX/degree context
  // proves a single decimal; plain "1 2" remains two values.
  text = text.replace(
    /(?<![\p{L}\d])([+-]?\d(?:\s*\d)*\s*\.\s*\d(?:\s*\d)*)(?=\s*(?:°|%|‰|$|[.,;]))/gu,
    (n) => n.replace(/\s+/gu, ""),
  );
  text = text
    .replace(/(?<=\p{Script=Han})\s+(?=\p{Script=Han})/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return text;
}
export function semanticTokens(value: string): SemanticTokens {
  const text = normalizeForComparison(value).replace(
    /(?<![\p{L}\p{N}_])(?:[A-Z][a-z]?(?:\d+|_\{\d+\})?)+(?![\p{L}\p{N}_])/gu,
    (formula) => formula.replace(/([A-Za-z])(\d+)/gu, "$1_{$2}"),
  );
  // Never coerce numbers to JS Number: 1.0 and 1.00 retain different significance.
  const regex =
    /[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|°[CF]|‰|%|[\p{L}]+|[_^]\{[^{}]*\}|[^\s]/gu;
  const sequence = [...text.matchAll(regex)].map((m) => m[0]);
  return {
    sequence,
    numbers: sequence.flatMap((s) => {
      if (/^[+-]?(?:\d|\.\d)/u.test(s)) return [s];
      const script = /^[_^]\{([+-]?(?:\d+(?:\.\d*)?|\.\d+))\}$/u.exec(s);
      return script ? [script[1]!] : [];
    }),
    units: sequence.filter((s) =>
      /^(?:°C|°F|%|‰|K|m|s|g|cm|kg|mol|mmol|nm|μm|Pa|kPa|MPa|L|mL)$/u.test(s),
    ),
    formulas: [
      ...text.matchAll(/(?:[A-Z][a-z]?(?:_?\{?\d+\}?)?){1,}(?=\b|[\s.,;])/gu),
    ].map((m) => m[0]),
  };
}
