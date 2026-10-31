import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { parsePageRegion } from "@sciretriever/contracts";
import { PdfRegionRenderer } from "../src/browser/pdf-region.js";
import {
  MupdfPageRenderer,
  mupdfBundleCandidates,
  resolveMupdfRuntime,
} from "../src/proofread/mupdf.js";

function pdf() {
  const streams = [
    "BT /F1 14 Tf 20 100 Td (Visible yield 12.5 C) Tj ET",
    "q 60 0 0 60 0 0 cm /Im1 Do Q BT /F1 12 Tf 3 Tr 20 100 Td (Hidden OCR) Tj ET",
    "q 60 0 0 60 0 0 cm /Im1 Do Q",
    "",
    "BT /F2 14 Tf 20 100 Td (A) Tj ET",
    "BT /F1 12 Tf 3 Tr 20 100 Td (Hidden) Tj ET q BT /F1 12 Tf 0 Tr 20 80 Td (Visible) Tj ET Q BT /F1 12 Tf 20 60 Td (Still hidden) Tj ET",
    "0 0 20 20 re f",
    "BT /F1 14 Tf 20 100 Td [(Ker)-5(ned) -250 (word)] TJ ET",
  ];
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${streams.map((_, i) => `${7 + i * 2} 0 R`).join(" ")}] /Count ${streams.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length 7 >>\nstream\nFF0000>\nendstream",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 6 0 R >>",
    "",
  ];
  const cmap =
    "begincmap\n1 begincodespacerange\n<00> <FF>\nendcodespacerange\n1 beginbfchar\n<41> <E000>\nendbfchar\nendcmap";
  objects[5] = `<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream`;
  for (const [i, content] of streams.entries()) {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 3 0 R /F2 5 0 R >> /XObject << /Im1 4 0 R >> >> /Contents ${8 + i * 2} 0 R >>`,
    );
    objects.push(
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    );
  }
  let text = "%PDF-1.7\n";
  const offsets = [0];
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(text));
    text += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(text);
  text += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
    .join(
      "",
    )}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text);
}

it("classifies visible Unicode, hidden OCR, unmapped glyphs, images and blank pages using bundled PDF.js", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sciretriever-pdf-pages-"));
  const renderer = new PdfRegionRenderer(
    process.env.SCIRETRIEVER_BROWSER_EXECUTABLE,
    pathToFileURL(join(directory, "reader/")),
  );
  try {
    await promisify(execFile)(process.execPath, [
      "scripts/build-reader-assets.mjs",
      directory,
    ]);
    const pages = await renderer.inspect(pdf());
    expect(pages.map((p) => p.kind)).toEqual([
      "text-layer",
      "image-only",
      "image-only",
      "blank",
      "image-only",
      "text-layer",
      "image-only",
      "text-layer",
    ]);
    expect(pages[0]!.text).toBe("Visible yield 12.5 C");
    expect(pages[1]).toMatchObject({ text: "", has_graphics: true });
    expect(pages[1]!.hidden_glyphs).toBeGreaterThan(0);
    expect(pages[4]!.unmapped_glyphs).toBe(1);
    expect(pages[5]!.text).toBe("Visible");
    expect(pages[7]!.text).toBe("Kerned word");
    const image = await renderer.render(
      pdf(),
      1,
      parsePageRegion([0, 0, 1000, 500]),
    );
    expect(Buffer.from(image.data).subarray(0, 8).toString("hex")).toBe(
      "89504e470d0a1a0a",
    );
    expect(image.width * image.height).toBeLessThanOrEqual(2010000);
    await expect(
      renderer.inspect(pdf(), AbortSignal.abort()),
    ).rejects.toThrow();
  } finally {
    await renderer.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

async function readerAssets() {
  const directory = await mkdtemp(join(tmpdir(), "sciretriever-pdf-pages-"));
  await promisify(execFile)(process.execPath, [
    "scripts/build-reader-assets.mjs",
    directory,
  ]);
  return directory;
}

it("inspects a PDF larger than one browser protocol message by reading it in ranges", async () => {
  const directory = await readerAssets();
  const renderer = new PdfRegionRenderer(
    process.env.SCIRETRIEVER_BROWSER_EXECUTABLE,
    pathToFileURL(join(directory, "reader/")),
  );
  try {
    // An unreferenced 80 MB object ahead of the pages: the whole file once
    // exceeded the ~100 MB message after base64 encoding.
    const original = Buffer.from(pdf()).toString("latin1"),
      head = "%PDF-1.7\n",
      padding = `% ${"x".repeat(80 * 1024 * 1024)}\n`,
      shifted = original
        .slice(head.length)
        .replace(
          /^(\d{10}) 00000 n /gmu,
          (_, offset: string) =>
            `${String(Number(offset) + padding.length).padStart(10, "0")} 00000 n `,
        )
        .replace(
          /startxref\n(\d+)/u,
          (_, offset: string) =>
            `startxref\n${Number(offset) + padding.length}`,
        );
    const large = Buffer.from(head + padding + shifted, "latin1");
    expect(large.length).toBeGreaterThan(80 * 1024 * 1024);
    const pages = await renderer.inspect(large);
    expect(pages.map((p) => p.kind)).toEqual(
      (await renderer.inspect(pdf())).map((p) => p.kind),
    );
    expect(pages[0]!.text).toBe("Visible yield 12.5 C");
  } finally {
    await renderer.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60000);

it("renders page images with the bundled mutool at the same size as PDF.js", async () => {
  const runtime = await resolveMupdfRuntime();
  if (!runtime)
    throw new Error("MuPDF bundle missing: run pnpm vendor:mupdf first");
  const directory = await readerAssets();
  const reference = new PdfRegionRenderer(
      process.env.SCIRETRIEVER_BROWSER_EXECUTABLE,
      pathToFileURL(join(directory, "reader/")),
    ),
    images = new MupdfPageRenderer(runtime);
  const bytes = pdf(),
    hash = createHash("sha256").update(bytes).digest("hex");
  try {
    for (const region of [null, parsePageRegion([0, 0, 1000, 500])]) {
      const expected = await reference.render(bytes, 1, region),
        image = await images.render(bytes, hash, 0, region);
      expect(Buffer.from(image.data).subarray(0, 8).toString("hex")).toBe(
        "89504e470d0a1a0a",
      );
      expect(Buffer.from(image.data).readUInt32BE(16)).toBe(image.width);
      expect([image.width, image.height]).toEqual([
        expected.width,
        expected.height,
      ]);
    }
    await expect(
      images.render(bytes, hash, 0, null, AbortSignal.abort()),
    ).rejects.toThrow();
  } finally {
    await reference.close();
    await images.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

it("uses a MuPDF bundle only when its manifest names the pinned version and executable digest", async () => {
  expect(mupdfBundleCandidates("relative/bundle")).toEqual([]);
  expect(mupdfBundleCandidates("/opt/mupdf")).toEqual(["/opt/mupdf"]);
  const runtime = await resolveMupdfRuntime();
  if (!runtime)
    throw new Error("MuPDF bundle missing: run pnpm vendor:mupdf first");
  const bundle = await mkdtemp(join(tmpdir(), "sciretriever-mupdf-bundle-"));
  try {
    await mkdir(join(bundle, "bin"));
    await copyFile(runtime.executable, join(bundle, "bin", "mutool"));
    const manifest = JSON.parse(
      await readFile(join(runtime.executable, "../../manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    await writeFile(join(bundle, "manifest.json"), JSON.stringify(manifest));
    expect(await resolveMupdfRuntime([bundle])).toMatchObject({
      version: "1.28.6",
    });
    await writeFile(
      join(bundle, "manifest.json"),
      JSON.stringify({ ...manifest, executable_sha256: "0".repeat(64) }),
    );
    expect(await resolveMupdfRuntime([bundle])).toBeUndefined();
    await writeFile(
      join(bundle, "manifest.json"),
      JSON.stringify({ ...manifest, version: "1.27.0" }),
    );
    expect(await resolveMupdfRuntime([bundle])).toBeUndefined();
  } finally {
    await rm(bundle, { recursive: true, force: true });
  }
});
