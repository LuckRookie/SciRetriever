import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseAsset,
  parseArtifactRef,
  parseProvenance,
  parseLiteratureContentProposal,
  contentCanonicalJsonBytes,
  literatureContentSha256,
  analysisInputSha256,
  sha256,
  type LiteratureSection,
  type LiteratureDetail,
} from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { TypeScriptParserArtifactRules } from "../src/parsing/artifact-rules.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";
export const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
export const lit = FIXTURE_LITERATURE.literature_id;
export function artifact(bytes: Uint8Array, media_type = "text/markdown") {
  return parseArtifactRef({
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byte_size: bytes.length,
    media_type,
  });
}
export async function setup(execution = false) {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-content-"));
  const app = await createApplication(home, {
    ...(execution ? { executionSchema: "upgrade-synthetic" as const } : {}),
    parsing: {
      rules: new TypeScriptParserArtifactRules(),
      parser: {
        parse: async (r) => {
          const bytes = Buffer.from("# Parsed fixture\n");
          return {
            source_asset_id: r.source_asset_id,
            source_sha256: r.source_sha256,
            page_count: 1,
            markdown: { artifact: artifact(bytes), bytes },
            resources: [],
            provenance: {
              provenance: parseProvenance({
                provenance_id: id(33),
                source_kind: "parser",
                source_name: "fixture",
                source_record_id: null,
                observed_at: "2026-09-10T00:00:00Z",
                input_sha256: r.source_sha256,
                parameters_sha256: "a".repeat(64),
              }),
              parser_version: "fixture",
              mode: null,
              model_identity: null,
            },
          };
        },
      },
    },
  });
  await app.database.putLiterature(FIXTURE_LITERATURE);
  const pdf = workbenchPdf();
  const stage = await app.files.stage();
  await stage.write(pdf);
  await app.files.publish(stage, "objects/source.pdf");
  const asset = parseAsset({
    asset_id: id(30),
    sha256: await sha256(pdf),
    size_bytes: pdf.length,
    media_type: "application/pdf",
    path: "objects/source.pdf",
  });
  await app.database.putLiteratureAsset({
    literature_asset_id: id(31),
    literature_id: lit,
    asset,
    role: "primary-pdf",
    source_url: null,
    provenance: {
      provenance_id: id(32),
      source_kind: "asset-provider",
      source_name: "fixture",
      source_record_id: null,
      observed_at: "2026-09-10T00:00:00Z",
      input_sha256: asset.sha256,
      parameters_sha256: null,
    },
  });
  await app.parsing!.commitCurrentPrimary(
    await app.parsing!.prepareCurrentPrimary(lit),
  );
  return {
    home,
    app,
    close: async () => {
      await app.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}
export async function proposal(
  detail: LiteratureDetail,
  n = 40,
  body = "Cafe\u0301 spectroscopy",
  keywords = ["spectroscopy"],
) {
  const metadata = { ...detail.literature.metadata, keywords };
  const metadata_sha256 = await sha256(contentCanonicalJsonBytes(metadata));
  const sections: LiteratureSection[] = [
    {
      role: "background-and-objectives",
      title: null,
      markdown: body,
      subsections: [],
    },
    ...(["methods", "data", "conclusions-and-limitations"] as const).map(
      (role) => ({ role, title: null, markdown: "未提供", subsections: [] }),
    ),
  ];
  const bytes = Buffer.from(`# Canonical fixture\n\n${body}\n`);
  const primary = detail.primary_pdf!.asset;
  const value = await parseLiteratureContentProposal({
    literature_id: detail.literature.literature_id,
    primary_asset_id: primary.asset_id,
    primary_pdf_sha256: primary.sha256,
    parser_result_sha256: detail.parser_result!.result_sha256,
    input_metadata_revision: detail.metadata_revision,
    input_metadata_sha256: detail.metadata_sha256,
    final_metadata: metadata,
    metadata_sha256,
    sections,
    references: ["Fixture reference"],
    literature_content_sha256: await literatureContentSha256({
      metadata_sha256,
      sections,
      references: ["Fixture reference"],
    }),
    markdown: artifact(bytes),
    provenance: {
      provenance_id: id(n),
      source_kind: "analysis",
      source_name: "fixture-analysis",
      source_record_id: null,
      observed_at: "2026-09-10T00:00:00Z",
      input_sha256: await analysisInputSha256(
        primary.sha256,
        detail.parser_result!.result_sha256,
        metadata_sha256,
      ),
      parameters_sha256: "b".repeat(64),
    },
  });
  return { value, bytes };
}
