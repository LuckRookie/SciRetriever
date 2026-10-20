import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { documentRepresentationHash } from "../src/document/contract.js";
const lit = "00000000-0000-0000-0000-000000000951";
const asset = "00000000-0000-0000-0000-000000000953";
const pdfHash = createHash("sha256").update("%PDF-1.4\n%%\n").digest("hex");
const parserHash = "c".repeat(64),
  markdownHash = "b".repeat(64);
it("hashes logical references and structure while leaving identity and provenance separate", async () => {
  const base = {
    proofread_id: "00000000-0000-0000-0000-000000000951",
    source_material_ref: {
      literature_id: lit,
      asset_id: asset,
      asset_sha256: pdfHash as never,
      media_type: "application/pdf",
      byte_size: 12,
      artifact: {
        sha256: pdfHash as never,
        byte_size: 12,
        media_type: "application/pdf",
      },
    },
    proofread_content_sha256: parserHash as never,
    builder_version: "proofread-blocks-v1",
    locator_scheme: "utf8-segment-v1",
    markdown: {
      sha256: markdownHash as never,
      byte_size: 10,
      media_type: "text/markdown",
    },
    structure: {
      sha256: "e".repeat(64) as never,
      byte_size: 24,
      media_type: "application/json",
    },
    resources: [
      {
        resource_id: "r1",
        reference: "figures/one.png",
        relation: "image" as const,
        artifact: {
          sha256: "f".repeat(64) as never,
          byte_size: 8,
          media_type: "image/png",
        },
      },
    ],
  };
  const first = await documentRepresentationHash(base);
  expect(first).toBe(await documentRepresentationHash(base));
  expect(first).not.toBe(
    await documentRepresentationHash({
      ...base,
      resources: [{ ...base.resources[0]!, reference: "figures/two.png" }],
    }),
  );
  expect(first).not.toBe(
    await documentRepresentationHash({
      ...base,
      structure: { ...base.structure, sha256: "0".repeat(64) as never },
    }),
  );
  await expect(
    documentRepresentationHash({
      ...base,
      resources: [{ ...base.resources[0]!, reference: "../unsafe.png" }],
    }),
  ).rejects.toBeDefined();
});
