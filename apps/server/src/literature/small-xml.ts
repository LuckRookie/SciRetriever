/*
 * A small, bounded XML reader for record-shaped exports (EndNote XML,
 * literature materials 6.4.14). It is a single linear scan with explicit
 * limits, not a general XML processor:
 *
 * - elements, attributes, text, CDATA; comments and processing instructions
 *   are skipped;
 * - the five predefined entities and numeric character references only; a
 *   DOCTYPE (and so any entity definition) is refused, nothing is expanded;
 * - no namespaces beyond keeping the qualified name as written;
 * - input, depth and element count are bounded; exceeding one is an error.
 */
export interface XmlElement {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly (XmlElement | string)[];
}
export class XmlReadError extends Error {
  constructor(readonly reason: string) {
    super(`xml: ${reason}`);
  }
}
export const XML_LIMITS = Object.freeze({
  characters: 8 * 1024 * 1024,
  depth: 32,
  elements: 400_000,
  attributes: 64,
});

const NAME = /[A-Za-z_:][A-Za-z0-9_.:-]*/uy;
const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeEntities(value: string): string {
  if (!value.includes("&")) return value;
  let out = "",
    i = 0;
  while (i < value.length) {
    const amp = value.indexOf("&", i);
    if (amp < 0) {
      out += value.slice(i);
      break;
    }
    out += value.slice(i, amp);
    const end = value.indexOf(";", amp);
    if (end < 0 || end - amp > 12) throw new XmlReadError("entity");
    const body = value.slice(amp + 1, end);
    let char: string | undefined;
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = /^[0-9A-Fa-f]{1,6}$/u.test(body.slice(2))
        ? Number.parseInt(body.slice(2), 16)
        : NaN;
      char = validCode(code) ? String.fromCodePoint(code) : undefined;
    } else if (body.startsWith("#")) {
      const code = /^[0-9]{1,7}$/u.test(body.slice(1))
        ? Number.parseInt(body.slice(1), 10)
        : NaN;
      char = validCode(code) ? String.fromCodePoint(code) : undefined;
    } else char = Object.hasOwn(ENTITIES, body) ? ENTITIES[body] : undefined;
    if (char === undefined) throw new XmlReadError("entity");
    out += char;
    i = end + 1;
  }
  return out;
}
function validCode(code: number): boolean {
  return (
    Number.isSafeInteger(code) &&
    code > 0 &&
    code <= 0x10ffff &&
    !(code >= 0xd800 && code <= 0xdfff)
  );
}

/** The document's root element. Throws XmlReadError on anything outside the subset or the limits. */
export function readXml(source: string): XmlElement {
  if (source.length > XML_LIMITS.characters)
    throw new XmlReadError("too-large");
  let i = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  let elements = 0;
  type Open = {
    name: string;
    attributes: Record<string, string>;
    children: (XmlElement | string)[];
  };
  const stack: Open[] = [];
  let root: XmlElement | null = null;
  const name = (): string => {
    NAME.lastIndex = i;
    const match = NAME.exec(source);
    if (!match) throw new XmlReadError("name");
    i += match[0].length;
    return match[0];
  };
  const space = () => {
    while (i < source.length && " \t\r\n".includes(source[i]!)) i++;
  };
  const text = (value: string) => {
    const top = stack.at(-1);
    if (!top) {
      if (value.trim()) throw new XmlReadError("text-outside-root");
      return;
    }
    if (value) top.children.push(value);
  };
  while (i < source.length) {
    const lt = source.indexOf("<", i);
    if (lt < 0) {
      text(decodeEntities(source.slice(i)));
      break;
    }
    if (lt > i) text(decodeEntities(source.slice(i, lt)));
    i = lt;
    if (source.startsWith("<!--", i)) {
      const end = source.indexOf("-->", i + 4);
      if (end < 0) throw new XmlReadError("comment");
      i = end + 3;
    } else if (source.startsWith("<![CDATA[", i)) {
      const end = source.indexOf("]]>", i + 9);
      if (end < 0 || !stack.length) throw new XmlReadError("cdata");
      text(source.slice(i + 9, end));
      i = end + 3;
    } else if (source.startsWith("<?", i)) {
      const end = source.indexOf("?>", i + 2);
      if (end < 0) throw new XmlReadError("instruction");
      i = end + 2;
    } else if (source.startsWith("<!", i)) {
      // DOCTYPE and declarations could define entities: refused, not expanded.
      throw new XmlReadError("declaration");
    } else if (source.startsWith("</", i)) {
      i += 2;
      const closing = name();
      space();
      if (source[i] !== ">") throw new XmlReadError("end-tag");
      i++;
      const open = stack.pop();
      if (!open || open.name !== closing) throw new XmlReadError("mismatch");
      const element: XmlElement = open;
      if (stack.length) stack.at(-1)!.children.push(element);
      else root = element;
    } else {
      i++;
      if (root) throw new XmlReadError("second-root");
      const tag = name(),
        attributes: Record<string, string> = {};
      let count = 0;
      for (;;) {
        space();
        if (source[i] === ">" || source.startsWith("/>", i)) break;
        const key = name();
        space();
        if (source[i] !== "=") throw new XmlReadError("attribute");
        i++;
        space();
        const quote = source[i];
        if (quote !== '"' && quote !== "'") throw new XmlReadError("attribute");
        const end = source.indexOf(quote, i + 1);
        if (end < 0) throw new XmlReadError("attribute");
        const raw = source.slice(i + 1, end);
        if (raw.includes("<")) throw new XmlReadError("attribute");
        if (++count > XML_LIMITS.attributes || Object.hasOwn(attributes, key))
          throw new XmlReadError("attribute");
        attributes[key] = decodeEntities(raw);
        i = end + 1;
      }
      if (++elements > XML_LIMITS.elements) throw new XmlReadError("too-many");
      const empty = source.startsWith("/>", i);
      i += empty ? 2 : 1;
      const element: Open = { name: tag, attributes, children: [] };
      if (empty) {
        if (stack.length) stack.at(-1)!.children.push(element);
        else root = element;
      } else {
        if (stack.length >= XML_LIMITS.depth)
          throw new XmlReadError("too-deep");
        stack.push(element);
      }
    }
  }
  if (stack.length || !root) throw new XmlReadError("unclosed");
  return root;
}

/** Direct children with this name. */
export function xmlChildren(
  element: XmlElement | undefined,
  name: string,
): XmlElement[] {
  return (element?.children ?? []).filter(
    (c): c is XmlElement => typeof c !== "string" && c.name === name,
  );
}
/** The first element down a path of child names. */
export function xmlPath(
  element: XmlElement | undefined,
  ...names: readonly string[]
): XmlElement | undefined {
  let current = element;
  for (const name of names) current = xmlChildren(current, name)[0];
  return current;
}
/** All text below an element in document order (EndNote wraps it in `style`). */
export function xmlText(element: XmlElement | undefined): string {
  if (!element) return "";
  let out = "";
  // Depth is bounded by readXml, so recursion is too.
  const visit = (e: XmlElement) => {
    for (const c of e.children)
      if (typeof c === "string") out += c;
      else visit(c);
  };
  visit(element);
  return out;
}
