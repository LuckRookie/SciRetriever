/** Parse reported numeric typography without evaluating expressions or units. */
export function reportedNumber(raw: string): number | null {
  const superscripts = "⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻";
  const digits = "0123456789+-";
  const text = raw
    .trim()
    .replace(/^\$([^$]+)\$$/u, "$1")
    .replace(/[−–]/gu, "-")
    .replace(/\\(?:times|cdot)/gu, "*")
    .replace(/[×·]/gu, "*")
    .replace(/\\(?:qquad|quad|,|;|!| )/gu, " ")
    .replace(
      /([⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻]+)/gu,
      (value) =>
        `^${[...value].map((c) => digits[superscripts.indexOf(c)]).join("")}`,
    )
    .replace(/\^\{\s*([+-]?\d+)\s*\}/gu, "^$1")
    .trim();
  const decimal = "[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)";
  let normalized: string;
  if (new RegExp(`^${decimal}(?:[eE][-+]?\\d+)?$`, "u").test(text)) {
    normalized = text;
  } else {
    const scientific = new RegExp(
      `^(?:(${decimal})\\s*\\*\\s*)?10\\s*\\^\\s*([+-]?\\d+)$`,
      "u",
    ).exec(text);
    if (!scientific) return null;
    normalized = `${scientific[1] ?? "1"}e${scientific[2]}`;
  }
  const value = Number(normalized);
  // An underflowed nonzero mantissa is not the reported value zero.
  if (!Number.isFinite(value)) return null;
  if (value === 0 && Number(normalized.split(/[eE]/u)[0]) !== 0) return null;
  return value;
}
