import { deflateSync } from "node:zlib";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  acceptPdf,
  PdfAcceptanceError,
  readPdfTool,
} from "../src/acquisition/pdf-acceptance.js";

function pdf(): Uint8Array {
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>\nendobj\n",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const object of objects) {
    offsets.push(body.length);
    body += object;
  }
  const xref = body.length;
  body += `xref\n0 4\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n `)
    .join(
      "\n",
    )}\ntrailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

/** A small compressed stream that expands beyond the first-page text limit. */
function compressedOutputFixture(): Uint8Array {
  const line = "X".repeat(80);
  const content = Array.from(
    { length: 5_000 },
    (_, index) =>
      `BT /F1 8 Tf 10 ${10 + (index % 760)} Td (${line}${String(index).padStart(5, "0")}) Tj ET`,
  ).join("\n");
  const compressed = deflateSync(Buffer.from(content), { level: 9 });
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    ),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
    Buffer.concat([
      Buffer.from(
        `<< /Length ${compressed.byteLength} /Filter /FlateDecode >>\nstream\n`,
      ),
      compressed,
      Buffer.from("\nendstream"),
    ]),
  ];
  let body = Buffer.from("%PDF-1.4\n");
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(body.byteLength);
    body = Buffer.concat([
      body,
      Buffer.from(`${index + 1} 0 obj\n`),
      object,
      Buffer.from("\nendobj\n"),
    ]);
  }
  const xref = body.byteLength;
  const trailer = Buffer.from(
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
      .slice(1)
      .map((offset) => `${String(offset).padStart(10, "0")} 00000 n `)
      .join(
        "\n",
      )}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
  );
  return new Uint8Array(Buffer.concat([body, trailer]));
}

describe("bounded PDF acceptance", () => {
  it("preserves a caller cancellation as a reader cause", async () => {
    const controller = new AbortController();
    const reading = readPdfTool(pdf(), "pdfinfo", 10000, controller.signal);
    controller.abort();
    await expect(reading).rejects.toMatchObject({
      code: "pdf-acceptance",
      cause: { code: "pdf-reader-cancelled" },
    });
    await expect(
      acceptPdf(pdf(), 10000, controller.signal),
    ).rejects.toMatchObject({
      cause: { code: "pdf-reader-cancelled" },
    });
  });
  it("preserves an unavailable sandbox launcher without exposing PDF content", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "sciretriever-pdf-tool-unavailable-"),
    );
    const prior = process.env.PATH;
    let reading: Promise<string>;
    try {
      process.env.PATH = directory;
      reading = readPdfTool(pdf(), "pdfinfo");
    } finally {
      if (prior === undefined) delete process.env.PATH;
      else process.env.PATH = prior;
    }
    try {
      await expect(reading).rejects.toMatchObject({
        code: "pdf-acceptance",
        cause: { code: "pdf-reader-unavailable", cause: { code: "ENOENT" } },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("keeps active reader deadlines distinct from invalid PDF input", async () => {
    await expect(
      readPdfTool(compressedOutputFixture(), "pdftotext", 1),
    ).rejects.toMatchObject({
      cause: { code: "pdf-reader-timeout" },
    });
  });
  it("accepts a readable one-page PDF through the standard reader", async () => {
    await expect(acceptPdf(pdf())).resolves.toEqual({
      accepted: true,
      page_count: 1,
    });
  });
  it("rejects HTML, empty bytes and malformed PDF input", async () => {
    await expect(acceptPdf(new Uint8Array())).rejects.toBeInstanceOf(
      PdfAcceptanceError,
    );
    await expect(
      acceptPdf(new TextEncoder().encode("<html>%PDF-fake</html>")),
    ).rejects.toBeInstanceOf(PdfAcceptanceError);
    await expect(
      acceptPdf(new TextEncoder().encode("%PDF-1.4\nnot a pdf")),
    ).rejects.toBeInstanceOf(PdfAcceptanceError);
  });
  it("rejects an encrypted trailer before invoking the PDF reader", async () => {
    const encrypted = new TextEncoder().encode(
      `${new TextDecoder().decode(pdf()).replace("%%EOF", "/Encrypt 9 0 R\n%%EOF")}\n`,
    );
    await expect(acceptPdf(encrypted)).rejects.toBeInstanceOf(
      PdfAcceptanceError,
    );
  });
  it("terminates a compressed stream when first-page text exceeds the output bound", async () => {
    const fixture = compressedOutputFixture();
    expect(fixture.byteLength).toBeLessThan(64 * 1024);
    await expect(readPdfTool(fixture, "pdftotext")).rejects.toBeInstanceOf(
      PdfAcceptanceError,
    );
  });
});
