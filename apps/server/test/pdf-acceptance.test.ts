import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acceptPdf,
  acceptPdfFile,
  PdfAcceptanceError,
} from "../src/acquisition/pdf-acceptance.js";
import {
  mupdfBundleCandidates,
  resolveMupdfRuntime,
} from "../src/proofread/mupdf.js";
import { FileStore } from "../src/storage/files/store.js";

/** A complete PDF with a correct cross-reference table. */
function document(bodies: readonly (string | Buffer)[]): Buffer {
  let body = Buffer.from("%PDF-1.4\n");
  const offsets: number[] = [];
  for (const [index, object] of bodies.entries()) {
    offsets.push(body.byteLength);
    body = Buffer.concat([
      body,
      Buffer.from(`${index + 1} 0 obj\n`),
      Buffer.from(object),
      Buffer.from("\nendobj\n"),
    ]);
  }
  const xref = body.byteLength;
  return Buffer.concat([
    body,
    Buffer.from(
      `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n${offsets
        .map((offset) => `${String(offset).padStart(10, "0")} 00000 n `)
        .join(
          "\n",
        )}\ntrailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
    ),
  ]);
}

function pdf(): Uint8Array {
  return new Uint8Array(
    document([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>",
    ]),
  );
}

/** Three text pages, each padded so a cut at half the file lands inside the page objects. */
function textPdf(): Buffer {
  const pages: string[] = [];
  const bodies: (string | Buffer)[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (let page = 0; page < 3; page++) {
    const content = Buffer.from(
      `BT /F1 12 Tf 72 720 Td (Synthetic acceptance page ${page + 1}) Tj ET\n% ${"x".repeat(2000)}\n`,
    );
    bodies.push(
      Buffer.concat([
        Buffer.from(
          `<< /Length ${content.byteLength} /Filter /FlateDecode >>\nstream\n`,
        ),
        deflateSync(content),
        Buffer.from("\nendstream"),
      ]),
    );
    bodies.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${bodies.length} 0 R >>`,
    );
    pages.push(`${bodies.length} 0 R`);
  }
  bodies[1] = `<< /Type /Pages /Kids [${pages.join(" ")}] /Count 3 >>`;
  return document(bodies);
}

const bundled = resolveMupdfRuntime(mupdfBundleCandidates(undefined));
let fixtures: string;
/** Encrypted variants written by the bundled MuPDF from the synthetic text PDF. */
async function encrypted(name: string, args: readonly string[]) {
  const runtime = await bundled;
  if (!runtime)
    throw new Error("Acceptance tests require the bundled MuPDF runtime");
  const input = join(fixtures, "plain.pdf"),
    output = join(fixtures, name);
  await writeFile(input, textPdf());
  const result = spawnSync(
    runtime.executable,
    ["clean", ...args, input, output],
    { timeout: 30_000 },
  );
  expect(result.status, result.stderr?.toString()).toBe(0);
  return new Uint8Array(await readFile(output));
}
beforeAll(async () => {
  fixtures = await mkdtemp(join(tmpdir(), "sciretriever-pdf-acceptance-"));
});
afterAll(async () => {
  await rm(fixtures, { recursive: true, force: true });
});

async function acceptFile(bytes: Uint8Array) {
  const root = await mkdtemp(join(tmpdir(), "sciretriever-pdf-accept-file-")),
    store = new FileStore(root),
    stage = await store.stage();
  try {
    await stage.write(bytes);
    return await stage.withFile((file) => acceptPdfFile(file));
  } finally {
    await stage.discard();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}
async function reason(acceptance: Promise<unknown>) {
  try {
    await acceptance;
    return "accepted";
  } catch (error) {
    expect(error).toBeInstanceOf(PdfAcceptanceError);
    return (error as PdfAcceptanceError).reason;
  }
}

describe("bounded PDF acceptance", () => {
  it("preserves a caller cancellation as a reader cause", async () => {
    const running = new AbortController();
    const reading = acceptPdf(pdf(), 10000, running.signal);
    setTimeout(() => running.abort(), 0);
    await expect(reading).rejects.toMatchObject({
      code: "pdf-acceptance",
      cause: { code: "pdf-reader-cancelled" },
    });
    const controller = new AbortController();
    controller.abort();
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
    let reading: Promise<unknown>;
    try {
      process.env.PATH = directory;
      reading = acceptPdf(pdf());
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
    await expect(acceptPdf(textPdf(), 1)).rejects.toMatchObject({
      cause: { code: "pdf-reader-timeout" },
    });
  });
  it("accepts a readable one-page PDF through the bundled MuPDF reader", async () => {
    await expect(acceptPdf(pdf())).resolves.toEqual({
      accepted: true,
      page_count: 1,
    });
    await expect(acceptFile(textPdf())).resolves.toEqual({
      accepted: true,
      page_count: 3,
    });
  });
  it("needs neither pdfinfo nor pdftotext on PATH", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sciretriever-no-poppler-"));
    const prior = process.env.PATH;
    try {
      const prlimit = spawnSync("sh", ["-c", "command -v prlimit"], {
        encoding: "utf8",
      }).stdout.trim();
      await symlink(prlimit, join(directory, "prlimit"));
      process.env.PATH = directory;
      expect(
        spawnSync("/bin/sh", ["-c", "command -v pdfinfo pdftotext"], {
          encoding: "utf8",
          env: { PATH: directory },
        }).stdout,
      ).toBe("");
      const reading = acceptPdf(pdf());
      process.env.PATH = prior;
      await expect(reading).resolves.toEqual({
        accepted: true,
        page_count: 1,
      });
    } finally {
      if (prior === undefined) delete process.env.PATH;
      else process.env.PATH = prior;
      await rm(directory, { recursive: true, force: true });
    }
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
    const encryptedTrailer = new TextEncoder().encode(
      `${new TextDecoder().decode(pdf()).replace("%%EOF", "/Encrypt 9 0 R\n%%EOF")}\n`,
    );
    await expect(acceptPdf(encryptedTrailer)).rejects.toBeInstanceOf(
      PdfAcceptanceError,
    );
  });
  it("rejects every repaired file, as a cut-off download looks, and keeps the other verdicts", async () => {
    const good = textPdf(),
      text = good.toString("latin1"),
      xref = text.lastIndexOf("xref"),
      start = text.lastIndexOf("startxref\n") + "startxref\n".length,
      end = text.indexOf("\n", start);
    const badStartxref = Buffer.from(
      text.slice(0, start) +
        String(Number(text.slice(start, end)) + 777) +
        text.slice(end),
      "latin1",
    );
    const png = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108020000009077" +
        "53de0000000c4944415408d763f8cfc000000301010018dd8db40000000049454e44ae426082",
      "hex",
    );
    const cases: [string, Uint8Array, string][] = [
      ["intact", good, "accepted"],
      ["cut at half", good.subarray(0, good.byteLength >> 1), "pdf-invalid"],
      ["no cross-reference table", good.subarray(0, xref), "pdf-invalid"],
      ["wrong startxref offset", badStartxref, "pdf-invalid"],
      [
        "no pages",
        document([
          "<< /Type /Catalog /Pages 2 0 R >>",
          "<< /Type /Pages /Kids [] /Count 0 >>",
        ]),
        "pdf-invalid",
      ],
      [
        "HTML",
        Buffer.from(
          "<!doctype html><html><body><p>Please sign in.</p></body></html>",
        ),
        "non-pdf-file",
      ],
      ["PNG", png, "non-pdf-file"],
      [
        "user password",
        await encrypted("user.pdf", [
          "-E",
          "aes-256",
          "-U",
          "user",
          "-O",
          "owner",
        ]),
        "encrypted-pdf",
      ],
      [
        "owner password only",
        await encrypted("owner.pdf", ["-E", "aes-128", "-O", "owner"]),
        "encrypted-pdf",
      ],
    ];
    for (const [name, bytes, verdict] of cases) {
      expect([name, await reason(acceptPdf(bytes))]).toEqual([name, verdict]);
      expect([name, await reason(acceptFile(bytes))]).toEqual([name, verdict]);
    }
  }, 60_000);
});
