import {
  parsePageRegion,
  parseRawBlocksV1,
  parseRawResourceReference,
  type RawBlock,
  type RawBlockType,
  type RawBlocksV1,
} from "@sciretriever/contracts";
import { ParsingFailure } from "../../ports.js";
import { parserMarkdownReferences } from "../../markdown-resources.js";

function fail(type?: string): never {
  // Only an identifier from the private protocol may leave the boundary; never arbitrary content.
  throw new ParsingFailure(
    "parser-structure",
    type && /^[a-z][a-z0-9_-]{0,63}$/u.test(type) ? type : undefined,
  );
}
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) fail();
  return v as Record<string, unknown>;
}
function string(v: unknown): string {
  if (typeof v !== "string" || v.length > 4 * 1024 * 1024) fail();
  return v;
}
function spans(v: unknown): string {
  if (!Array.isArray(v) || v.length > 100000) fail();
  return v
    .map((value) => {
      const s = object(value);
      if (
        !["text", "equation_inline", "phonetic", "md", "code_inline"].includes(
          String(s.type),
        )
      )
        fail(String(s.type));
      return s.type === "equation_inline"
        ? `$${string(s.content)}$`
        : string(s.content);
    })
    .join("");
}

// Both renderers at MinerU 3.4.4 / 0dfc9460cd9ab693b9af60ae3fbffd7bc111b062
// emit page arrays. Vendor captions remain separate neutral blocks with the
// enclosing region; no smaller caption box is invented.
const SIMPLE: Readonly<Record<string, readonly [RawBlockType, string]>> = {
  title: ["title", "title_content"],
  paragraph: ["text", "paragraph_content"],
  page_header: ["header", "page_header_content"],
  page_footer: ["footer", "page_footer_content"],
  page_number: ["page-number", "page_number_content"],
  page_aside_text: ["aside", "page_aside_text_content"],
  page_footnote: ["footnote", "page_footnote_content"],
};
export function convertMinerUContentList(
  value: unknown,
  pageCount: number,
): {
  readonly blocks: RawBlocksV1;
  readonly references: readonly string[];
} {
  if (!Array.isArray(value) || value.length !== pageCount) fail();
  const blocks: RawBlock[] = [];
  const references = new Set<string>();
  value.forEach((pageValue, page) => {
    if (!Array.isArray(pageValue) || pageValue.length > 100000) fail();
    let index = 0;
    for (const item of pageValue) {
      const r = object(item);
      const source = string(r.type);
      const c = object(r.content);
      const bbox = parsePageRegion(r.bbox);
      const add = (
        type: RawBlockType,
        text: string,
        html: string | null = null,
        image_ref: string | null = null,
      ) => {
        blocks.push({
          page,
          index: index++,
          type,
          text,
          html,
          image_ref,
          bbox,
          title_level: type === "title" ? (c.level as number) : null,
          source_type: source,
        });
      };
      const caption = (name: string, type: "caption" | "footnote") => {
        if (c[name] !== undefined) {
          const text = spans(c[name]);
          if (text) add(type, text);
        }
      };
      if (SIMPLE[source]) {
        const [type, field] = SIMPLE[source];
        add(type, spans(c[field]));
      } else if (
        ["image", "chart", "table", "equation_interline"].includes(source)
      ) {
        const path = object(c.image_source).path;
        // 3.4.4 VLM formats table/equation paths as `${bucket}/${image_path}`,
        // including the literal "images/" when no crop exists. This exact vendor
        // sentinel is absence, not a reference to a directory or fabricated image.
        const absent =
          path === "" ||
          (path === "images/" &&
            ["table", "equation_interline"].includes(source));
        const image = absent ? null : parseRawResourceReference(path);
        if (image) references.add(image);
        if (source === "table") {
          const html = string(c.html);
          for (const ref of parserMarkdownReferences(html)) references.add(ref);
          add("table", "", html, image);
        } else if (source === "equation_interline") {
          if (c.math_type !== "latex") fail();
          add("equation", string(c.math_content), null, image);
        } else
          add(
            "image",
            c.content === undefined ? "" : string(c.content),
            null,
            image,
          );
        caption(`${source}_caption`, "caption");
        caption(`${source}_footnote`, "footnote");
      } else if (source === "code" || source === "algorithm") {
        add("text", spans(c[`${source}_content`]));
        caption(`${source}_caption`, "caption");
        caption(`${source}_footnote`, "footnote");
      } else if (source === "list" || source === "index") {
        if (
          !Array.isArray(c.list_items) ||
          !["text_list", "reference_list"].includes(String(c.list_type))
        )
          fail();
        for (const value of c.list_items) {
          const item = object(value);
          if (item.item_type !== "text") fail(String(item.item_type));
          add(
            c.list_type === "reference_list" ? "reference" : "list",
            spans(item.item_content),
          );
        }
      } else fail(source);
    }
  });
  const refs = [...references].sort();
  return {
    blocks: parseRawBlocksV1(
      { schema_version: 1, page_count: pageCount, blocks },
      refs,
    ),
    references: refs,
  };
}
