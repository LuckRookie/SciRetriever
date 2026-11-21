import { cp, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  canonicalJsonBytes,
  parseRawParseInput,
  rawParseIdentity,
  type ArtifactRef,
  type RawParse,
} from "@sciretriever/contracts";
import {
  buildDraftDocument,
  draftArtifact,
} from "../src/document/draft-builder.js";
import { artifactReference } from "../src/storage/artifact-layout.js";
import { runRawParseStorage } from "../src/storage/sqlite/raw-parsing-engine.js";
import { runDraftTextWrite } from "../src/storage/sqlite/draft-text-engine.js";
import { archiveFixture } from "./archive-fixture.js";

export const SCALE_LIBRARY_DATE = "2026-11-21T00:00:00.000Z";

/** Real page tree and xref. An uncompressed image stream makes up most of the bytes. */
export function scaleLibraryPdf(label: string, pages: number, size: number) {
  const firstPage = 4,
    image = firstPage + pages,
    content = image + 1;
  const list = Array.from({ length: pages }, (_, i) => `${firstPage + i} 0 R`);
  const page = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> /XObject << /Im0 ${image} 0 R >> >> /Contents ${content} 0 R >>`;
  const stream = `BT /F1 14 Tf 40 740 Td (Synthetic scale library ${label}) Tj ET\nq 360 0 0 360 40 310 cm /Im0 Do Q\n`;
  const rasterHeight = Math.floor((size - pages * 280 - 4096) / 1024);
  const raster = Buffer.alloc(1024 * rasterHeight, 238);
  for (let row = 0; row < rasterHeight; row++)
    raster.fill(200 + (row % 30), row * 1024, row * 1024 + 48);
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from(`<< /Type /Pages /Kids [${list.join(" ")}] /Count ${pages} >>`),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
    ...list.map(() => Buffer.from(page)),
    Buffer.concat([
      Buffer.from(
        `<< /Type /XObject /Subtype /Image /Width 1024 /Height ${rasterHeight} /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${raster.length} >>\nstream\n`,
      ),
      raster,
      Buffer.from("\nendstream"),
    ]),
    Buffer.from(
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    ),
  ];
  const buffers = [Buffer.from("%PDF-1.4\n")];
  const offsets = ["0000000000 65535 f \n"];
  let at = buffers[0]!.length;
  for (const [index, object] of objects.entries()) {
    offsets.push(`${String(at).padStart(10, "0")} 00000 n \n`);
    const head = Buffer.from(`${index + 1} 0 obj\n`);
    const end = Buffer.from("\nendobj\n");
    buffers.push(head, object, end);
    at += head.length + object.length + end.length;
  }
  buffers.push(
    Buffer.from(
      `xref\n0 ${offsets.length}\n${offsets.join("")}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(buffers);
}

/** Copy a single verified corrected archive from a disposable, fully synthetic test fixture. */
export async function seedScaleLibraryCatalog(
  catalog: string,
  artifacts: string,
  seed: number,
) {
  const example = await archiveFixture({
    offline: true,
    sourcePdf: scaleLibraryPdf(`corrected-${seed}`, 1, 96 * 1024),
  });
  try {
    await example.app.documentProcessing.parseDocuments(
      example.rawParseRequest,
    );
    const task = await example.submit(`scale-library-corrected-${seed}`);
    if (
      task.failures.length ||
      (await example.app.archive.status(example.id)).status !== "READY"
    )
      throw new Error("The corrected scale sample did not reach READY");
    const source = new DatabaseSync(join(example.home, "catalog.sqlite"));
    try {
      source.prepare("VACUUM INTO ?").run(catalog);
    } finally {
      source.close();
    }
    await cp(
      example.app.configuration.paths.artifact_root ??
        join(example.home, "artifacts"),
      artifacts,
      {
        recursive: true,
        errorOnExist: true,
        force: false,
      },
    );
    return example.id;
  } finally {
    await example.close();
  }
}

interface StoredArtifact {
  artifact: ArtifactRef;
  reference: string;
}
export interface ScalePdf extends StoredArtifact {
  asset: string;
  pages: number;
}
async function artifactFile(
  db: DatabaseSync,
  root: string,
  kind: Parameters<typeof artifactReference>[0],
  bytes: Uint8Array,
  mediaType: string,
): Promise<StoredArtifact> {
  const artifact = draftArtifact(bytes, mediaType);
  const known = db
    .prepare(
      "SELECT relative_path FROM artifact_objects WHERE sha256=? AND byte_size=?",
    )
    .get(artifact.sha256, artifact.byte_size);
  if (known) return { artifact, reference: String(known.relative_path) };
  const reference = artifactReference(kind, artifact),
    path = join(root, reference);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
  return { artifact, reference };
}

export async function addScalePdf(
  db: DatabaseSync,
  root: string,
  asset: string,
  label: string,
  pages: number,
  size: number,
): Promise<ScalePdf> {
  const { artifact, reference } = await artifactFile(
    db,
    root,
    "original-pdf",
    scaleLibraryPdf(label, pages, size),
    "application/pdf",
  );
  db.prepare(
    "INSERT INTO artifact_objects(artifact_id,sha256,byte_size,media_type,relative_path) VALUES(?,?,?,?,?)",
  ).run(
    asset,
    artifact.sha256,
    artifact.byte_size,
    artifact.media_type,
    reference,
  );
  db.prepare("INSERT INTO assets VALUES(?,?,?,?,?)").run(
    asset,
    artifact.sha256,
    artifact.byte_size,
    artifact.media_type,
    reference,
  );
  return { asset, pages, artifact, reference };
}

export async function addScaleRawParse(
  db: DatabaseSync,
  root: string,
  pdf: ScalePdf,
): Promise<{ raw: RawParse; text: string; bytes: Buffer }> {
  const text = `# Synthetic scale study\n\nOptical measurements on a synthetic specimen are reported for ${pdf.asset}.\n\n# Results\n\nThe methods and observations are designed for offline retrieval tests.\n`;
  const bytes = Buffer.from(text);
  const markdown = await artifactFile(
    db,
    root,
    "parser-markdown",
    bytes,
    "text/markdown",
  );
  const input = parseRawParseInput({
    source_asset_id: pdf.asset,
    source_sha256: pdf.artifact.sha256,
    profile: "vlm-engine-markdown-only",
    parser_version: "synthetic-scale-1",
    model_identity: null,
    parameters_sha256: pdf.artifact.sha256,
    page_count: pdf.pages,
    page_sizes: [],
    blocks: null,
    markdown: markdown.artifact,
    resources: [],
    private_content_list: null,
  });
  const raw = { ...input, ...(await rawParseIdentity(input)) };
  const manifest = await artifactFile(
    db,
    root,
    "raw-parse-manifest",
    canonicalJsonBytes(raw),
    "application/json",
  );
  runRawParseStorage(db, "publish", {
    result: raw,
    manifest: { ...manifest.artifact, reference: manifest.reference },
    resources: [
      {
        ...markdown.artifact,
        reference: "",
        artifact_reference: markdown.reference,
        kind: "markdown",
      },
    ],
  });
  return { raw, text, bytes };
}

export async function addScaleDraft(
  db: DatabaseSync,
  root: string,
  pdf: ScalePdf,
  literature_id: string,
) {
  const { raw, text, bytes } = await addScaleRawParse(db, root, pdf);
  const output = await buildDraftDocument(
    raw,
    {
      async readArtifact(id, kind) {
        if (id !== raw.raw_parse_id || kind !== "markdown")
          throw new Error("Unexpected scale draft input");
        return bytes;
      },
    },
    [
      {
        page: 0,
        kind: "text-layer",
        text,
        visible_glyphs: text.length,
        unmapped_glyphs: 0,
        hidden_glyphs: 0,
        has_graphics: true,
      },
    ],
    {
      literature_id,
      asset_id: pdf.asset,
      asset_sha256: pdf.artifact.sha256,
      media_type: pdf.artifact.media_type,
      byte_size: pdf.artifact.byte_size,
      artifact: pdf.artifact,
    },
  );
  const content = await artifactFile(
    db,
    root,
    "draft-content",
    output.content_bytes,
    "application/json",
  );
  const markdown = await artifactFile(
    db,
    root,
    "draft-markdown",
    output.markdown,
    "text/markdown",
  );
  const structure = await artifactFile(
    db,
    root,
    "document-structure",
    output.structure_bytes,
    "application/json",
  );
  runDraftTextWrite(db, {
    kind: "commit",
    publication: {
      version: output.document,
      source_artifact_path: pdf.reference,
      draft_content_artifact_path: content.reference,
      markdown_artifact_path: markdown.reference,
      structure_artifact_path: structure.reference,
      resource_artifact_paths: {},
      facts: output.counts,
      expected_current_revision: null,
      expected_default_revision: null,
    },
  });
  return {
    version: output.document.document_version_id,
    segment: output.structure.segments[0]!.segment_id,
  };
}
