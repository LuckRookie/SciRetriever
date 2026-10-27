/** Inline tags publishers leave in titles, raw or entity-escaped; the only markup a title keeps. */
const TITLE_TAG = /<(\/?)(i|em|b|strong|sub|sup|scp)\s*>/giu;
const TAGS = {
  i: "i",
  em: "i",
  b: "b",
  strong: "b",
  sub: "sub",
  sup: "sup",
  scp: "scp",
} as const;
type TitleTag = (typeof TAGS)[keyof typeof TAGS];
export type TitlePart =
  | string
  | { readonly tag: TitleTag; readonly parts: readonly TitlePart[] };

function decoded(raw: string): string {
  const decoder = document.createElement("textarea");
  return (
    raw
      .replace(/&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);/giu, (entity) => {
        decoder.innerHTML = entity;
        return decoder.value;
      })
      // Crossref pads subscripts with a space ("Li <sub>6</sub>"); a subscript never follows one.
      .replace(/\s+(?=<sub\s*>)/giu, "")
  );
}

/** Text, plus nested inline tags; an unclosed or stray tag keeps only its text. */
export function titleParts(raw: string | null | undefined): TitlePart[] {
  const text = raw ? decoded(raw).trim() : "";
  const root: TitlePart[] = [];
  const open: { tag: TitleTag; parts: TitlePart[] }[] = [];
  const into = () => open.at(-1)?.parts ?? root;
  let at = 0;
  for (const match of text.matchAll(TITLE_TAG)) {
    if (match.index > at) into().push(text.slice(at, match.index));
    at = match.index + match[0].length;
    const tag = TAGS[match[2]!.toLowerCase() as keyof typeof TAGS];
    if (!match[1]) open.push({ tag, parts: [] });
    else if (open.at(-1)?.tag === tag) {
      const done = open.pop()!;
      into().push(done);
    }
  }
  if (at < text.length) into().push(text.slice(at));
  while (open.length) into().push(...open.pop()!.parts);
  return root;
}

export function titleText(parts: readonly TitlePart[]): string {
  return parts
    .map((part) => (typeof part === "string" ? part : titleText(part.parts)))
    .join("");
}

/** DOM rendering for the framework-free reading engine; text is never parsed as HTML. */
export function appendTitle(target: HTMLElement, parts: readonly TitlePart[]) {
  for (const part of parts) {
    if (typeof part === "string") {
      target.append(part);
      continue;
    }
    const element = document.createElement(
      part.tag === "scp" ? "span" : part.tag,
    );
    if (part.tag === "scp") element.className = "title-small-caps";
    appendTitle(element, part.parts);
    target.append(element);
  }
}
