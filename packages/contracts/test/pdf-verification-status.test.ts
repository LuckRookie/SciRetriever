import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  parseAsset,
  parseCandidatePublicationIntent,
  parseLiteratureAssetView,
} from "../src/index.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../tests/fixtures/compat-v1/records.json", import.meta.url),
    "utf8",
  ),
) as Record<string, unknown>;
const asset = parseAsset(fixture.asset);
const view = {
  asset,
  literature_asset: {
    literature_asset_id: "00000000-0000-0000-0000-000000000003",
    literature_id: "00000000-0000-0000-0000-000000000001",
    asset_id: asset.asset_id,
    role: "primary-pdf",
    provenance: fixture.provenance,
    source_url: null,
  },
};
it("accepts classified and legacy PDF publication paths without admitting other namespaces", () => {
  const intent = {
    receipt_id: "fixture-receipt",
    metadata_snapshot: { revision: 1, sha256: asset.sha256 },
    candidate: {
      transfer_id: "fixture-transfer",
      state: "durable-ready",
      sha256: asset.sha256,
      size_bytes: asset.size_bytes,
      reference: `.candidates/${asset.sha256}.bin`,
      capture: null,
      source_name: "fixture",
      source_record_id: null,
    },
    literature_id: view.literature_asset.literature_id,
    asset_id: asset.asset_id,
    literature_asset_id: view.literature_asset.literature_asset_id,
    provenance: fixture.provenance,
    source_url: null,
    identity: "unverified",
  };
  for (const target of [
    "objects/legacy.pdf",
    `originals/pdf/${asset.sha256.slice(0, 2)}/${asset.sha256}.pdf`,
  ])
    expect(parseCandidatePublicationIntent({ ...intent, target }).target).toBe(
      target,
    );
  const original = parseCandidatePublicationIntent({
    ...intent,
    target: "objects/legacy.pdf",
  });
  expect(Object.hasOwn(original, "intake_batch_id")).toBe(false);
  const withOwner = parseCandidatePublicationIntent({
    ...original,
    intake_batch_id: view.literature_asset.literature_id,
  });
  const { intake_batch_id, ...unchanged } = withOwner;
  expect(intake_batch_id).toBe(view.literature_asset.literature_id);
  expect(JSON.stringify(unchanged)).toBe(JSON.stringify(original));
  expect(() =>
    parseCandidatePublicationIntent({
      ...original,
      intake_batch_id: "invalid",
    }),
  ).toThrow();
  for (const target of [
    ".staging/unpublished.pdf",
    intent.candidate.reference,
    "knowledge/summaries/not-an-original.pdf",
    "originals/pdf/../../../config.toml",
    "/originals/pdf/absolute.pdf",
  ])
    expect(() =>
      parseCandidatePublicationIntent({ ...intent, target }),
    ).toThrow();
});
it("reads legacy PDF views as unverified without asserting article identity", () => {
  const parsed = parseLiteratureAssetView(view);
  expect(parsed.article_identity_status).toBe("unverified");
  expect(parseLiteratureAssetView(parsed)).toEqual(parsed);
  expect(() =>
    parseLiteratureAssetView({ ...view, article_identity_status: "verified" }),
  ).toThrow();
  expect(() =>
    parseLiteratureAssetView({ ...view, article_identity_status: null }),
  ).toThrow();
});
it("does not attach a PDF identity label to a non-PDF asset", () => {
  const parsed = parseLiteratureAssetView({
    ...view,
    asset: { ...asset, media_type: "text/html" },
    literature_asset: { ...view.literature_asset, role: "html" },
  });
  expect(parsed.article_identity_status).toBeNull();
  expect(parseLiteratureAssetView(parsed)).toEqual(parsed);
});
