import { describe, expect, it } from "vitest";
import { createLogger } from "../src/logging/index.js";

describe("structured logging redaction", () => {
  it("keeps diagnostics while removing secret fields and URL credentials", () => {
    const lines: string[] = [];
    const logger = createLogger("agents", (line) => lines.push(line));
    logger.info("request failed", {
      provider: "openai",
      endpoint: "https://user:secret@api.example.test/path?token=secret",
      authorization: "Bearer secret",
      vendor_message: "vendor secret detail",
      http_status: 429,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("provider=openai");
    expect(lines[0]).toContain("http_status=429");
    expect(lines[0]).not.toContain("secret");
    expect(lines[0]).not.toContain("authorization");
    expect(lines[0]).not.toContain("vendor secret detail");
  });

  it("keeps stdout payloads separate and honors the minimum level", () => {
    const lines: string[] = [];
    const logger = createLogger("runtime", (line) => lines.push(line), "warn");
    logger.debug("debug detail");
    logger.info("progress");
    logger.warn("provider response", { status: 429 });
    expect(lines).toEqual([
      "WARN component=runtime provider response status=429",
    ]);
    expect(lines.join("\n")).not.toContain('{"result"');
  });
});
