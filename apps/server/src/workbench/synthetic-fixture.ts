import { createServer } from "node:http";
import { once } from "node:events";
import { parseLiterature } from "@sciretriever/contracts";

/**
 * Synthetic article, PDF, and loopback HTTP site for the explicit Workbench
 * preview and offline integration tests. It is not part of the normal product
 * application path and never contacts real providers or user data.
 */

export const FIXTURE_DOI = "10.5555/sciretriever.fixture";
export const FIXTURE_TITLE = "Synthetic literature workbench";
export const FIXTURE_LITERATURE = parseLiterature({
  literature_id: "00000000-0000-0000-0000-000000000001",
  meta_literature_id: "00000000-0000-0000-0000-000000000002",
  version_role: "published",
  status: "UNREVIEWED",
  metadata: {
    title: FIXTURE_TITLE,
    authors: [],
    abstract: null,
    publication_date: null,
    publication_year: 2026,
    document_type: "article",
    language: "en",
    venue: null,
    publisher: null,
    volume: null,
    issue: null,
    pages: null,
    identifiers: [{ namespace: "doi", value: FIXTURE_DOI }],
    keywords: [],
  },
});

/** Deterministic, valid PDF with extractable first-page identity evidence. */
export function workbenchPdf(
  identifier = FIXTURE_DOI,
  version = "published",
  includeIdentity = true,
): Uint8Array {
  const escape = (value: string) =>
    value
      .replaceAll("\\", "\\\\")
      .replaceAll("(", "\\(")
      .replaceAll(")", "\\)");
  const content = includeIdentity
    ? `BT /F1 14 Tf 40 740 Td (${escape(FIXTURE_TITLE)}) Tj 0 -24 Td (DOI: ${escape(identifier)}) Tj 0 -24 Td (Version: ${escape(version)}) Tj ET`
    : "";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n `)
    .join(
      "\n",
    )}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(body));
}

export async function startWorkbenchFixture(): Promise<{
  readonly origin: string;
  close(): Promise<void>;
}> {
  const server = createServer((request, response) => {
    if (request.method !== "GET") {
      response.writeHead(405);
      response.end();
      return;
    }
    if (request.url === "/slow.pdf") {
      const bytes = workbenchPdf();
      response.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Length": bytes.byteLength,
        "Content-Disposition": 'attachment; filename="slow-fixture.pdf"',
      });
      let offset = 0;
      const write = () => {
        if (offset >= bytes.byteLength) {
          response.end();
          return;
        }
        const next = Math.min(bytes.byteLength, offset + 64);
        response.write(bytes.slice(offset, next));
        offset = next;
        setTimeout(write, 25).unref();
      };
      write();
      return;
    }
    if (
      request.url === "/paper.pdf" ||
      request.url === "/inline.pdf" ||
      request.url === "/uncertain.pdf" ||
      request.url === "/range.pdf"
    ) {
      const bytes = workbenchPdf(
        request.url === "/uncertain.pdf"
          ? "10.5555/another.article"
          : FIXTURE_DOI,
      );
      response.writeHead(request.url === "/range.pdf" ? 206 : 200, {
        "Content-Type": "application/pdf",
        "Content-Length": bytes.byteLength,
        ...(request.url !== "/inline.pdf" && request.url !== "/range.pdf"
          ? { "Content-Disposition": 'attachment; filename="fixture.pdf"' }
          : {}),
      });
      response.end(bytes);
      return;
    }
    if (request.url === "/redirect") {
      response.writeHead(302, { Location: "/article" });
      response.end();
      return;
    }
    if (request.url === "/popup") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(
        `<!doctype html><html><body><a href="/paper.pdf" download>Popup PDF</a><script>setTimeout(() => document.querySelector('a').click(), 500)</script></body></html>`,
      );
      return;
    }
    if (request.url !== "/article") {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    const encoded = Buffer.from(workbenchPdf()).toString("base64");
    response.end(
      `<!doctype html><html lang="en"><meta charset="utf-8"><title>${FIXTURE_TITLE}</title><style>body{max-width:820px;margin:80px auto;font:18px/1.65 Georgia,serif;color:#20372d;background:#faf8ef}h1{font-size:44px;line-height:1.15}a,button{display:inline-block;margin:12px 12px 12px 0;padding:12px 20px;background:#235a46;color:white;border:0;border-radius:8px}small{font:14px system-ui;color:#657269}input{padding:12px}</style><main><small>SCIRETRIEVER · LOCAL SYNTHETIC FIXTURE</small><h1>${FIXTURE_TITLE}</h1><p>DOI: ${FIXTURE_DOI} · Version: published</p><p>This offline article exercises real Browser observation, controlled input, PDF capture and durable publication. All content is synthetic.</p><a href="/paper.pdf" download>Download PDF</a><a href="/slow.pdf" download>Slow PDF</a><a href="/uncertain.pdf" download>Uncertain PDF</a><a href="/popup" target="_blank">Popup PDF</a><a id="data-download" href="data:application/pdf;base64,${encoded}" download>Data PDF</a><a id="blob-download" download>Blob PDF</a><button onclick="fetch('/range.pdf')">Range PDF</button><button onclick="fetch('/inline.pdf')">Capture response PDF</button><p><label>Notes <input aria-label="Notes"></label><button onclick="document.querySelector('output').textContent='Input received'">Check input</button><output></output></p></main><script>const raw=atob('${encoded}');const bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));document.querySelector('#blob-download').href=URL.createObjectURL(new Blob([bytes],{type:'application/pdf'}));</script></html>`,
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("fixture unavailable");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
