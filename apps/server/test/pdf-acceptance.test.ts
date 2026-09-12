import { describe, expect, it } from "vitest";
import {
  acceptPdf,
  PdfAcceptanceError,
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

describe("bounded PDF acceptance", () => {
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
});
