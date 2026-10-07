import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseAsset, parseLiteratureAssetView } from "../src/index.js";

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
