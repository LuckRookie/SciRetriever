import { describe, expect, it } from "vitest";
import {
  buildDocumentStructure,
  MAX_DOCUMENT_MARKDOWN_BYTES,
} from "../src/document/builder.js";

describe("Document UTF-8 structure builder", () => {
  it("recognizes only ATX headings outside fenced and indented code, with linear nesting", async () => {
    const source = Buffer.from(
      "# 一级\r\n```md\r\n# 假标题\r\n```\r\n    ## 缩进代码\r\n## 二级\r\n文本😀\r\n# 末章\r\n",
    );
    const built = await buildDocumentStructure(source);
    expect(
      built.structure.sections.map((section) => [section.title, section.level]),
    ).toEqual([
      ["一级", 1],
      ["二级", 2],
      ["末章", 1],
    ]);
    const sections = built.structure.sections;
    expect(sections[0]!.end_utf8).toBe(
      Buffer.byteLength(
        "# 一级\r\n```md\r\n# 假标题\r\n```\r\n    ## 缩进代码\r\n## 二级\r\n文本😀\r\n",
      ),
    );
    expect(sections[1]!.end_utf8).toBe(sections[0]!.end_utf8);
    expect(sections[2]!.end_utf8).toBe(source.byteLength);
    expect(
      built.structure.segments.filter((segment) => segment.kind === "heading"),
    ).toHaveLength(3);
    for (const segment of built.structure.segments)
      expect(
        new TextDecoder("utf-8", { fatal: true }).decode(
          source.subarray(segment.start_utf8, segment.end_utf8),
        ),
      ).not.toBe("");
  });

  it("rejects oversized input and cancellation before allocation-heavy parsing", async () => {
    await expect(
      buildDocumentStructure(new Uint8Array(MAX_DOCUMENT_MARKDOWN_BYTES + 1)),
    ).rejects.toThrow();
    const controller = new AbortController();
    controller.abort();
    await expect(
      buildDocumentStructure(Buffer.from("# title\n"), controller.signal),
    ).rejects.toThrow();
  });

  it("observes a timer cancellation while building a long valid Markdown", async () => {
    const controller = new AbortController();
    const building = buildDocumentStructure(
      Buffer.from("# Title\n" + "line\n".repeat(80_000)),
      controller.signal,
    );
    setTimeout(() => controller.abort(), 0);
    await expect(building).rejects.toThrow(/cancelled/);
  });
});
