/**
 * Finding a quoted stretch in its paragraph (ADR 0074 §4, spec 10.3): the
 * model copies its evidence from the paragraph, the program finds where.
 * Exact first; else both sides normalized (whitespace, TeX markup, citation
 * marks, dashes, quotes, NFKC, case) with a map back to the original; else
 * the same with TeX symbol commands read as the character they display;
 * else a place at most two characters away (a corrected misspelling) that is
 * the only one in the paragraph. More than one place is no place.
 */

/** Positions are JavaScript string indices of the paragraph, half-open. */
export interface QuoteRange {
  readonly start: number;
  readonly end: number;
}
export type QuoteMiss = "empty" | "long" | "missing" | "ambiguous";

/** TeX symbol commands as the character they display (replaces rendering). */
const SYMBOLS: Readonly<Record<string, string>> = {
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ε",
  varepsilon: "ε",
  zeta: "ζ",
  eta: "η",
  theta: "θ",
  vartheta: "θ",
  iota: "ι",
  kappa: "κ",
  lambda: "λ",
  mu: "μ",
  nu: "ν",
  xi: "ξ",
  pi: "π",
  varpi: "π",
  rho: "ρ",
  varrho: "ρ",
  sigma: "σ",
  varsigma: "ς",
  tau: "τ",
  upsilon: "υ",
  phi: "φ",
  varphi: "φ",
  chi: "χ",
  psi: "ψ",
  omega: "ω",
  Gamma: "Γ",
  Delta: "Δ",
  Theta: "Θ",
  Lambda: "Λ",
  Xi: "Ξ",
  Pi: "Π",
  Sigma: "Σ",
  Upsilon: "Υ",
  Phi: "Φ",
  Psi: "Ψ",
  Omega: "Ω",
  circ: "°",
  degree: "°",
  textdegree: "°",
  times: "×",
  cdot: "·",
  pm: "±",
  mp: "∓",
  rightarrow: "→",
  to: "→",
  leftarrow: "←",
  leftrightarrow: "↔",
  rightleftharpoons: "⇌",
  approx: "≈",
  sim: "∼",
  leq: "≤",
  geq: "≥",
  le: "≤",
  ge: "≥",
  neq: "≠",
  infty: "∞",
  equiv: "≡",
  AA: "Å",
  prime: "′",
  partial: "∂",
};
/** Escaped characters that print themselves. */
const LITERALS = new Set(["%", "&", "#"]);
const DASHES = /[‐-―−﹣－]/gu;
const DIGITS = "[\\d,\\s\\u2010-\\u2015\\u2212-]+";
/** Citation marks, skipped on both sides: a quote may keep or drop them. */
const CITATION = new RegExp(
  `^(?:\\$\\s*\\^\\{?\\s*${DIGITS}\\}?\\s*\\$|\\[${DIGITS}\\]|<sup>${DIGITS}</sup>)`,
  "u",
);
const TAG = /^<\/?(?:sup|sub|i|b|em|strong)>/u;
const ENTITIES: Readonly<Record<string, string>> = {
  "&gt;": ">",
  "&lt;": "<",
  "&amp;": "&",
  "&quot;": '"',
  "&#x27;": "'",
  "&#39;": "'",
};
const MARKUP = /[\s$^_{}~]/u;
const SPACE = /\s/u;
/** KaTeX's ring and asterisk operators count as the degree sign and `*`. */
const fold = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/∘/gu, "°")
    .replace(/∗/gu, "*")
    .replace(DASHES, "-")
    .replace(/[“”„″]/gu, '"')
    .replace(/[‘’‚′]/gu, "'");

interface Normalized {
  readonly out: string;
  /** For each UTF-16 unit of `out`, the original range it came from. */
  readonly from: readonly number[];
  readonly to: readonly number[];
}
/** Text without spacing and markup; `symbols` reads symbol commands as characters. */
export function normalizeQuote(text: string, symbols: boolean): Normalized {
  let out = "";
  const from: number[] = [],
    to: number[] = [];
  const emit = (s: string, a: number, b: number) => {
    for (const ch of fold(s)) {
      if (SPACE.test(ch)) continue;
      out += ch;
      for (let u = 0; u < ch.length; u++) {
        from.push(a);
        to.push(b);
      }
    }
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "$" || ch === "[" || ch === "<") {
      const cite = CITATION.exec(text.slice(i, i + 48));
      if (cite) {
        i += cite[0].length - 1;
        continue;
      }
    }
    if (ch === "\\") {
      const m = /^\\([A-Za-z]+|.)/su.exec(text.slice(i));
      if (!m) continue;
      const name = m[1]!;
      if (LITERALS.has(name)) emit(name, i, i + 2);
      else if (symbols && SYMBOLS[name])
        emit(SYMBOLS[name], i, i + m[0].length);
      i += m[0].length - 1;
      continue;
    }
    if (MARKUP.test(ch)) continue;
    if (ch === "<") {
      const m = TAG.exec(text.slice(i, i + 12));
      if (m) {
        i += m[0].length - 1;
        continue;
      }
    }
    if (ch === "&") {
      const m = /^&[#\w]+;/u.exec(text.slice(i, i + 10));
      const entity = m ? ENTITIES[m[0]] : undefined;
      if (m && entity) {
        emit(entity, i, i + m[0].length);
        i += m[0].length - 1;
        continue;
      }
    }
    emit(ch, i, i + 1);
  }
  return { out, from, to };
}

/** Inline formulas `$…$` of a text, as [start, end). */
function formulas(text: string): [number, number][] {
  const spans: [number, number][] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] !== "$") continue;
    const double = text[i + 1] === "$";
    const close = text.indexOf(double ? "$$" : "$", i + (double ? 2 : 1));
    if (close < 0) break;
    const end = close + (double ? 2 : 1);
    spans.push([i, end]);
    i = end - 1;
  }
  return spans;
}
/** A range never cuts a formula: one that starts or ends inside it takes it whole. */
function widen(text: string, r: QuoteRange): QuoteRange {
  let { start, end } = r;
  for (const [a, b] of formulas(text)) {
    if (start > a && start < b) start = a;
    if (end > a && end < b) end = b;
  }
  return { start, end };
}

/** The fuzzy pass needs this many normalized characters: two edits must stay a small part. */
export const QUOTE_FUZZY_MIN = 12;
/** At most this many edits (insert, delete, replace) on the normalized strings. */
export const QUOTE_FUZZY_EDITS = 2;
/**
 * Places in `p` at most two edits from `q` (approximate substring search):
 * the end of every window within the bound, with its start. Overlapping
 * windows are one place, and the closest window in it is taken; null when
 * there is none, "ambiguous" when there are two places or more.
 */
function fuzzy(
  p: string,
  q: string,
): { start: number; end: number } | "ambiguous" | null {
  const n = p.length,
    m = q.length;
  let prev = new Int32Array(n + 1),
    cur = new Int32Array(n + 1),
    prevStart = new Int32Array(n + 1),
    curStart = new Int32Array(n + 1);
  for (let j = 0; j <= n; j++) prevStart[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    curStart[0] = 0;
    for (let j = 1; j <= n; j++) {
      const diag = prev[j - 1]! + (q[i - 1] === p[j - 1] ? 0 : 1);
      const up = prev[j]! + 1;
      const left = cur[j - 1]! + 1;
      if (diag <= up && diag <= left) {
        cur[j] = diag;
        curStart[j] = prevStart[j - 1]!;
      } else if (up <= left) {
        cur[j] = up;
        curStart[j] = prevStart[j]!;
      } else {
        cur[j] = left;
        curStart[j] = curStart[j - 1]!;
      }
    }
    [prev, cur] = [cur, prev];
    [prevStart, curStart] = [curStart, prevStart];
  }
  let best: { start: number; end: number; cost: number } | null = null;
  let place: { start: number; end: number } | null = null;
  for (let j = 1; j <= n; j++) {
    const cost = prev[j]!;
    if (cost > QUOTE_FUZZY_EDITS) continue;
    const start = prevStart[j]!;
    if (start >= j) continue;
    if (place && start >= place.end) return "ambiguous"; // a second place
    place = place
      ? { start: Math.min(place.start, start), end: j }
      : { start, end: j };
    if (!best || cost < best.cost) best = { start, end: j, cost };
  }
  return best && { start: best.start, end: best.end };
}

/**
 * Where `quote` is in `text` (one paragraph), or why it is not used. A quote
 * over `max` code points is not looked for.
 */
export function locateQuote(
  text: string,
  quote: string,
  max: number,
): QuoteRange | { readonly miss: QuoteMiss } {
  const q = quote.trim();
  if (!q) return { miss: "empty" };
  if ([...q].length > max) return { miss: "long" };
  const at = text.indexOf(q);
  if (at >= 0)
    return text.indexOf(q, at + 1) >= 0
      ? { miss: "ambiguous" }
      : widen(text, { start: at, end: at + q.length });
  let normalized: Normalized | null = null,
    target = "";
  for (const symbols of [false, true]) {
    const p = normalizeQuote(text, symbols);
    const n = normalizeQuote(q, symbols).out;
    normalized = p;
    target = n;
    if (!n) return { miss: "missing" };
    const hit = p.out.indexOf(n);
    if (hit < 0) continue;
    if (p.out.indexOf(n, hit + 1) >= 0) return { miss: "ambiguous" };
    return widen(text, {
      start: p.from[hit]!,
      end: p.to[hit + n.length - 1]!,
    });
  }
  // A corrected misspelling: one place at most two characters away.
  if (!normalized || target.length < QUOTE_FUZZY_MIN)
    return { miss: "missing" };
  const place = fuzzy(normalized.out, target);
  if (place === null) return { miss: "missing" };
  if (place === "ambiguous") return { miss: "ambiguous" };
  return widen(text, {
    start: normalized.from[place.start]!,
    end: normalized.to[place.end - 1]!,
  });
}

/**
 * A note's evidence quotes located in their paragraph (spec 10.3): the first
 * `keep` are looked for, the rest dropped; misses are dropped; the places
 * found are sorted, and overlapping ones or ones with only whitespace between
 * become one range. `dropped` counts every quote not used.
 */
export function locateQuotes(
  text: string,
  quotes: readonly string[],
  keep: number,
  max: number,
): { readonly ranges: QuoteRange[]; readonly dropped: number } {
  let dropped = Math.max(0, quotes.length - keep);
  const found: QuoteRange[] = [];
  for (const quote of quotes.slice(0, keep)) {
    const r = locateQuote(text, quote, max);
    if ("miss" in r) dropped++;
    else found.push(r);
  }
  found.sort((a, b) => a.start - b.start || a.end - b.end);
  const ranges: QuoteRange[] = [];
  for (const r of found) {
    const last = ranges.at(-1);
    if (last && (r.start <= last.end || !text.slice(last.end, r.start).trim()))
      ranges[ranges.length - 1] = {
        start: last.start,
        end: Math.max(last.end, r.end),
      };
    else ranges.push(r);
  }
  return { ranges, dropped };
}
