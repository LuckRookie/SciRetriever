import { createHash } from "node:crypto";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ReadingMark } from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { readPdfPageFrames } from "../src/literature/pdf-page-frames.js";
import {
  annotationMarkRequest,
  annotationReason,
  frameRects,
  markColor,
  pageFrame,
} from "../src/literature/zotero-annotations.js";
import type { ScopedFileReader } from "../src/storage/files/reader.js";
import { A, PDF_A, USER, annotation } from "./zotero-fixture.js";

/** A complete PDF whose pages carry the given page-dictionary entries. */
function pdf(pages: readonly string[]): Buffer {
  const bodies = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${i + 3} 0 R`).join(" ")}] /Count ${pages.length} /MediaBox [0 0 612 792] >>`,
    ...pages.map((entries) => `<< /Type /Page /Parent 2 0 R ${entries} >>`),
  ];
  let body = Buffer.from("%PDF-1.4\n");
  const offsets: number[] = [];
  for (const [index, object] of bodies.entries()) {
    offsets.push(body.byteLength);
    body = Buffer.concat([
      body,
      Buffer.from(`${index + 1} 0 obj\n${object}\nendobj\n`),
    ]);
  }
  const xref = body.byteLength;
  return Buffer.concat([
    body,
    Buffer.from(
      `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n${offsets
        .map((o) => `${String(o).padStart(10, "0")} 00000 n `)
        .join(
          "\n",
        )}\ntrailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
    ),
  ]);
}
/** Five pages: 0–3 plain Letter, 4 cropped and turned 90°. */
const PAGES = ["", "", "", "", "/CropBox [36 36 576 756] /Rotate 90"] as const;
const HIGHLIGHT = [72, 640.2, 300.5, 652] as const;

describe("page frames and rectangles", () => {
  it("converts a plain, a cropped and a turned page; refuses what lies outside", () => {
    const plain = pageFrame([0, 0, 612, 792], 0);
    expect(plain).toMatchObject({ width: 612, height: 792 });
    expect(frameRects([HIGHLIGHT], plain)).toEqual([[72, 140, 228.5, 11.8]]);
    // Crop: the box offset is subtracted first.
    const cropped = pageFrame([36, 36, 576, 756], 0);
    expect(cropped).toMatchObject({ width: 540, height: 720 });
    expect(frameRects([HIGHLIGHT], cropped)).toEqual([[36, 104, 228.5, 11.8]]);
    // Rotate 90 (clockwise): the user-space bottom-left comes to the top-left.
    const turned = pageFrame([0, 0, 612, 792], 90);
    expect(turned).toMatchObject({ width: 792, height: 612 });
    expect(frameRects([HIGHLIGHT], turned)).toEqual([[640.2, 72, 11.8, 228.5]]);
    expect(
      frameRects([[90, 300, 400, 520]], pageFrame([36, 36, 576, 756], 90)),
    ).toEqual([[264, 54, 220, 310]]);
    expect(
      frameRects([[100, 100, 200, 200]], pageFrame([0, 0, 612, 792], 180)),
    ).toEqual([[412, 100, 100, 100]]);
    expect(
      frameRects([[100, 100, 200, 200]], pageFrame([0, 0, 612, 792], 270)),
    ).toEqual([[592, 412, 100, 100]]);
    // Outside the visible box, empty, or no rectangle at all: not imported.
    expect(frameRects([[600, 700, 700, 720]], plain)).toBeNull();
    expect(frameRects([[10, 10, 20, 900]], cropped)).toBeNull();
    expect(frameRects([[10, 10, 10, 20]], plain)).toBeNull();
    expect(frameRects([], plain)).toBeNull();
    // Within a point of the edge: kept, held to the page.
    expect(frameRects([[0, 0, 612.5, 10]], plain)).toEqual([[0, 782, 612, 10]]);
  });

  it("reads the frames MuPDF computes from the page boxes of a synthetic PDF", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sciretriever-frames-"));
    const path = join(directory, "pages.pdf");
    await writeFile(
      path,
      pdf([...PAGES, "/MediaBox [0 0 300 300] /Rotate 180"]),
    );
    const handle = await open(path, "r");
    const file = {
      withDescriptor: (consume: (fd: number) => Promise<unknown>) =>
        consume(handle.fd),
    } as unknown as ScopedFileReader;
    try {
      const read = await readPdfPageFrames(file, [0, 4, 5, 9]);
      expect(read.page_count).toBe(6);
      expect([...read.frames.keys()]).toEqual([0, 4, 5]);
      expect(read.frames.get(0)).toEqual(pageFrame([0, 0, 612, 792], 0));
      expect(read.frames.get(4)).toEqual(pageFrame([36, 36, 576, 756], 90));
      expect(read.frames.get(5)).toEqual(pageFrame([0, 0, 300, 300], 180));
    } finally {
      await handle.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("annotation rules", () => {
  const base = {
    external_id: "ANNO0001",
    file_external_id: "PDFA0001",
    kind: "highlight" as const,
    quote: "synthetic sentence",
    note: "",
    color: "#ffd400",
    page_index: 2,
    coordinate_space: "pdf-bottom-left" as const,
    rects: [HIGHLIGHT],
  };
  it("maps Zotero's eight colours to the nearest of five; an unreadable one is blue", () => {
    expect(
      [
        "#ffd400",
        "#f19837",
        "#ff6666",
        "#5fb236",
        "#2ea8e5",
        "#aaaaaa",
        "#a28ae5",
        "#e56eee",
      ].map(markColor),
    ).toEqual([
      "yellow",
      "yellow",
      "red",
      "green",
      "blue",
      "blue",
      "purple",
      "purple",
    ]);
    expect(markColor("#FFD401")).toBe("yellow");
    expect(markColor("#e00")).toBe("red");
    expect(markColor("chartreuse")).toBe("blue");
    expect(markColor(null)).toBe("blue");
  });
  it("decides kind, comment, quote and position shape before the file", () => {
    expect(annotationReason(base)).toBeNull();
    expect(annotationReason({ ...base, kind: "note" })).toBe(
      "unsupported-kind",
    );
    expect(annotationReason({ ...base, kind: "ink" })).toBe("unsupported-kind");
    expect(annotationReason({ ...base, kind: "text" })).toBe(
      "unsupported-kind",
    );
    expect(annotationReason({ ...base, note: "x".repeat(20000) })).toBeNull();
    expect(annotationReason({ ...base, note: "x".repeat(20001) })).toBe(
      "comment-too-long",
    );
    expect(annotationReason({ ...base, quote: " " })).toBe("quote-invalid");
    expect(annotationReason({ ...base, kind: "region", quote: "" })).toBeNull();
    expect(annotationReason({ ...base, page_index: null })).toBe(
      "position-invalid",
    );
    expect(annotationReason({ ...base, rects: [] })).toBe("position-invalid");
  });
  it("builds the reading-mark request on the main PDF, or names why not", () => {
    const target = {
      literature_id: "00000000-0000-4000-8000-000000000001",
      sha256: "a".repeat(64),
      mark_id: "00000000-0000-4000-8000-000000000002",
      page_count: 3,
      frames: new Map([[2, pageFrame([0, 0, 612, 792], 0)]]),
    };
    expect(
      annotationMarkRequest({ ...base, note: "see #density" }, target),
    ).toEqual({
      request: {
        operation: "create",
        request: {
          mark_id: target.mark_id,
          literature_id: target.literature_id,
          kind: "highlight",
          color: "yellow",
          note: "see #density",
          quote: "synthetic sentence",
          pdf: {
            sha256: target.sha256,
            page: 3,
            rects: [[72, 140, 228.5, 11.8]],
          },
          document: null,
        },
      },
    });
    expect(annotationMarkRequest({ ...base, page_index: 3 }, target)).toEqual({
      reason: "position-invalid",
    });
    expect(
      annotationMarkRequest({ ...base, rects: [[700, 10, 800, 20]] }, target),
    ).toEqual({ reason: "position-invalid" });
  });
});

describe("importing Zotero annotations through an intake batch", () => {
  const actor = { kind: "local" as const, origin: "web" as const };
  async function* chunks(value: Uint8Array) {
    yield value;
  }
  // Sizes stated by Zotero would not match the synthetic bytes.
  const { links, ...bareA } = A;
  void links;
  const file = {
    ...PDF_A,
    links: { self: PDF_A.links.self, alternate: PDF_A.links.alternate },
  };
  const annotations = (prefix: string) => [
    annotation(
      `${prefix}01`,
      "highlight",
      { pageIndex: 2, rects: [HIGHLIGHT] },
      {
        annotationText: "synthetic highlighted sentence",
        annotationComment: "check #density",
      },
    ),
    annotation(
      `${prefix}02`,
      "image",
      { pageIndex: 4, rects: [[90, 300, 400, 520]] },
      { annotationColor: "#a28ae5" },
    ),
    annotation(
      `${prefix}03`,
      "underline",
      { pageIndex: 7, rects: [[1, 1, 2, 2]] },
      { annotationText: "beyond the last page" },
    ),
    annotation(
      `${prefix}04`,
      "highlight",
      { pageIndex: 0, rects: [[1, 1, 2, 2]] },
      { annotationText: "long", annotationComment: "x".repeat(20001) },
    ),
    annotation(`${prefix}05`, "note", { pageIndex: 0, rects: [[1, 1, 2, 2]] }),
  ];
  const source = (library: string) => ({
    system: "zotero",
    library_id: library,
    identity: "global" as const,
    name: library,
  });
  const marksOf = async (
    app: Awaited<ReturnType<typeof createApplication>>,
    id: string,
  ) =>
    (
      (await app.marks.query({
        operation: "list",
        request: { literature_id: id },
      })) as { items: ReadingMark[] }
    ).items;

  it("imports on the identical main PDF, never twice, and keeps deletions; a different PDF imports none", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-zotero-marks-"));
    const app = await createApplication(home, {
      indexRefreshIntervalMs: null,
      metadata: { lookup_ports: [], topic_search_ports: [] },
    });
    expect(app.metadata.lookup_selection).toEqual([]);
    const bytes = pdf([...PAGES]);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const batch = async (library: string, items: unknown[]) => {
      const s = await app.importSessions.create(
        { format: "zotero-api", source: source(library), scope: library },
        actor,
      );
      await app.importSessions.putData(s.batch_id, 0, { items });
      return s.batch_id;
    };
    try {
      const first = await batch(`users/${USER}`, [
        bareA,
        file,
        ...annotations("ANNOA0"),
      ]);
      const preview = await app.importSessions.preview(first);
      expect(preview.summary.annotations).toEqual({
        supported: 4,
        unsupported: 1,
        imported: 0,
        deferred: 3,
        importable: 3,
        by_reason: {
          "unsupported-kind": 1,
          "annotation-other-file": 0,
          "pdf-differs": 0,
          "file-missing": 0,
          "position-invalid": 0,
          "comment-too-long": 1,
          "quote-invalid": 0,
          "already-imported": 0,
        },
      });
      await app.importSessions.confirm(first);
      const [pending] = (await app.importSessions.missingFiles(first)).items;
      expect(pending).toMatchObject({
        external_id: "PDFA0001",
        action: "upload",
      });
      await app.importSessions.upload(first, pending!.file_id, chunks(bytes));
      const report = await app.importSessions.report(first, null, 200);
      expect(report.batch.state).toBe("finished");
      expect(report.summary.annotations).toMatchObject({
        imported: 2,
        deferred: 0,
        importable: 2,
        by_reason: {
          "position-invalid": 1,
          "comment-too-long": 1,
          "unsupported-kind": 1,
        },
      });
      const literature = report.items[0]!.literature_id!;
      const marks = await marksOf(app, literature);
      expect(
        marks.map((m) => [m.kind, m.color, m.note, m.quote, m.pdf]),
      ).toEqual([
        [
          "highlight",
          "yellow",
          "check #density",
          "synthetic highlighted sentence",
          { sha256: sha, page: 3, rects: [[72, 140, 228.5, 11.8]] },
        ],
        [
          "region",
          "purple",
          "",
          "",
          { sha256: sha, page: 5, rects: [[264, 54, 220, 310]] },
        ],
      ]);
      expect(marks[0]!.tags).toEqual(["density"]);

      // Again from the same library: matched by the external IDs, nothing new.
      // A mark deleted here stays deleted.
      await app.marks.manage({
        operation: "delete",
        request: { mark_id: marks[1]!.mark_id },
      });
      const again = await batch(`users/${USER}`, [
        bareA,
        file,
        ...annotations("ANNOA0"),
      ]);
      expect(
        (await app.importSessions.preview(again)).summary.annotations,
      ).toMatchObject({
        // The one outside the PDF is tried again; it never became a mark.
        deferred: 1,
        by_reason: { "already-imported": 2, "position-invalid": 0 },
      });
      await app.importSessions.confirm(again);
      const [hash] = (await app.importSessions.missingFiles(again)).items;
      expect(hash).toMatchObject({ action: "hash" });
      await app.importSessions.reportHash(again, hash!.file_id, sha);
      expect(
        (await app.importSessions.report(again, null, 200)).summary.annotations,
      ).toMatchObject({
        imported: 0,
        deferred: 0,
        by_reason: { "already-imported": 2, "position-invalid": 1 },
      });
      expect((await marksOf(app, literature)).map((m) => m.kind)).toEqual([
        "highlight",
      ]);

      // Another library names the same paper with another PDF: all skipped.
      const other = await batch(`groups/7`, [
        bareA,
        file,
        ...annotations("ANNOB0"),
      ]);
      await app.importSessions.confirm(other);
      const [different] = (await app.importSessions.missingFiles(other)).items;
      await app.importSessions.reportHash(
        other,
        different!.file_id,
        "b".repeat(64),
      );
      expect(
        (await app.importSessions.report(other, null, 200)).summary.annotations,
      ).toMatchObject({
        imported: 0,
        deferred: 0,
        by_reason: { "pdf-differs": 3, "already-imported": 0 },
      });
      expect(await marksOf(app, literature)).toHaveLength(1);
    } finally {
      await app.close();
      await rm(home, { recursive: true, force: true });
    }
  }, 60000);

  it("withdraws the imported marks nobody touched; a touched one keeps the paper", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-zotero-withdraw-"));
    const app = await createApplication(home, {
      indexRefreshIntervalMs: null,
      metadata: { lookup_ports: [], topic_search_ports: [] },
    });
    expect(app.metadata.lookup_selection).toEqual([]);
    const run = async (library: string, prefix: string, doi: string) => {
      const title = `Synthetic withdrawal paper ${doi}`;
      const item = {
        ...bareA,
        csljson: { ...bareA.csljson, DOI: doi, title },
        data: { ...bareA.data, DOI: doi, title },
      };
      const s = await app.importSessions.create(
        { format: "zotero-api", source: source(library), scope: library },
        actor,
      );
      await app.importSessions.putData(s.batch_id, 0, {
        items: [item, file, ...annotations(prefix)],
      });
      await app.importSessions.confirm(s.batch_id);
      const [pending] = (await app.importSessions.missingFiles(s.batch_id))
        .items;
      // Distinct bytes per paper: one PDF belongs to one paper here.
      await app.importSessions.upload(
        s.batch_id,
        pending!.file_id,
        chunks(pdf([...PAGES, `/Doi (${doi})`])),
      );
      const report = await app.importSessions.report(s.batch_id, null, 200);
      expect(report.summary.annotations).toMatchObject({ imported: 2 });
      return { id: s.batch_id, literature: report.items[0]!.literature_id! };
    };
    try {
      const untouched = await run("groups/1", "ANNOC0", "10.5555/synth.w1");
      expect(
        await app.importSessions.withdrawalPreview(untouched.id),
      ).toMatchObject({
        withdrawal: {
          remove: { literatures: 1, marks: 2 },
          keep: { literatures: 0 },
        },
      });
      await app.importSessions.withdraw(untouched.id);

      const touched = await run("groups/2", "ANNOD0", "10.5555/synth.w2");
      const [mark] = await marksOf(app, touched.literature);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await app.marks.manage({
        operation: "update",
        request: { mark_id: mark!.mark_id, color: "green" },
      });
      expect(
        await app.importSessions.withdrawalPreview(touched.id),
      ).toMatchObject({
        withdrawal: {
          remove: { literatures: 0, marks: 0 },
          keep: { literatures: 1, by_reason: { annotated: 1 } },
        },
      });
    } finally {
      await app.close();
      await rm(home, { recursive: true, force: true });
    }
  }, 60000);
});
