import { expect, it } from "vitest";
import { markdownBlocks, markdown } from "../src/reading/markdown.js";

it("maps normalized Markdown blocks back to original UTF-8 boundaries including CRLF and non-BMP text", () => {
  const text = "# 标题🙂\r\n\r\nαβ content.\r\n";
  const blocks = markdownBlocks(text),
    bytes = Buffer.from(text);
  expect(bytes.subarray(blocks[0]!.start, blocks[0]!.end).toString()).toBe(
    "# 标题🙂",
  );
  const paragraph = blocks.find((b) => b.token.type === "paragraph")!;
  expect(paragraph.start).toBe(bytes.indexOf(Buffer.from("αβ")));
  expect(
    bytes.subarray(paragraph.start, paragraph.end).toString().trimEnd(),
  ).toBe("αβ content.");
  const unsafe = markdown.parse(
    '<img src="https://example.invalid/tracker" onerror="alert(1)"> [x](javascript:alert(1)) ![x](https://example.invalid/image)',
    { async: false },
  );
  expect(unsafe).not.toMatch(/<img|href="javascript:/);
  expect(unsafe).toContain("&lt;img");
});
