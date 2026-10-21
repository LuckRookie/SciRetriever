import { escape as e } from "./dom.js";

const containers = new Set([
  "TABLE",
  "THEAD",
  "TBODY",
  "TFOOT",
  "TR",
  "TH",
  "TD",
  "CAPTION",
  "P",
  "BR",
  "STRONG",
  "B",
  "EM",
  "I",
  "SUB",
  "SUP",
]);
const forbidden = new Set([
  "SCRIPT",
  "STYLE",
  "IFRAME",
  "OBJECT",
  "EMBED",
  "LINK",
  "META",
  "SVG",
  "MATH",
]);
/** Rebuild table content from an inert template; never insert the supplied HTML into the live document. */
export function renderTable(
  text: string,
  inline: (value: string) => string,
): string | null {
  if (!/^\s*<table\b/iu.test(text) || typeof document === "undefined")
    return null;
  const template = document.createElement("template");
  template.innerHTML = text;
  const root = template.content.firstElementChild;
  if (
    root?.tagName !== "TABLE" ||
    template.content.childElementCount !== 1 ||
    [...template.content.childNodes].some(
      (n) => n !== root && n.textContent?.trim(),
    )
  )
    return null;
  const walk = (node: Node, depth: number): string => {
    if (node.nodeType === 3) return inline(node.textContent ?? "");
    if (node.nodeType !== 1) return "";
    if (depth > 32) return e(node.textContent ?? "");
    const element = node as Element,
      name = element.tagName;
    if (forbidden.has(name)) return "";
    if (name === "IMG") {
      const reference = element.getAttribute("src") ?? "";
      if (
        !reference ||
        /^(?:[a-z][a-z\d+.-]*:|\/|#)/iu.test(reference) ||
        reference.includes("\\") ||
        reference.split("/").some((p) => p === ".." || p === ".")
      )
        return "";
      return `<span class="reading-resource" data-resource="${e(reference)}">图片：${e(element.getAttribute("alt") || reference)}</span>`;
    }
    const children = [...element.childNodes]
      .map((n) => walk(n, depth + 1))
      .join("");
    if (!containers.has(name)) return children;
    let attributes = "";
    if (name === "TH" || name === "TD")
      for (const key of ["rowspan", "colspan"]) {
        const value = element.getAttribute(key);
        if (
          value &&
          /^\d{1,5}$/u.test(value) &&
          Number(value) >= (key === "rowspan" ? 0 : 1) &&
          Number(value) <= (key === "rowspan" ? 65534 : 1000)
        )
          attributes += ` ${key}="${value}"`;
      }
    const tag = name.toLowerCase();
    return name === "BR" ? "<br>" : `<${tag}${attributes}>${children}</${tag}>`;
  };
  return walk(root, 0);
}
