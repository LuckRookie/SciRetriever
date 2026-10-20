import { expect, it } from "vitest";
import { EMPTY_METADATA, parseLiterature } from "@sciretriever/contracts";
import {
  referenceIdentityMetadata,
  matchArchiveReference,
} from "../src/literature/reference-matching.js";
const source = "00000000-0000-4000-8000-000000000001",
  target = "00000000-0000-4000-8000-000000000002";
const bibliography =
  "@article{a,title={Synthetic Study},author={Ada Example},year={2026}}";
const literature = (doi: string | null) =>
  parseLiterature({
    literature_id: target,
    meta_literature_id: "00000000-0000-4000-8000-000000000003",
    version_role: "published",
    status: "UNREVIEWED",
    metadata: doi
      ? {
          ...EMPTY_METADATA,
          title: "Different title",
          identifiers: [{ namespace: "doi", value: doi }],
        }
      : referenceIdentityMetadata({ doi: null, text: bibliography }),
  });
it("matches exact DOI, rejects ambiguous identity and never chooses a near title", () => {
  const ref = { doi: "10.1234/example", text: "Synthetic citation" },
    candidate = literature("10.1234/example");
  expect(matchArchiveReference(source, ref, [candidate])).toMatchObject({
    target: candidate,
    basis: "doi",
  });
  expect(
    matchArchiveReference(source, ref, [
      candidate,
      parseLiterature({ ...candidate, literature_id: source }),
    ]).target,
  ).toBeNull();
  expect(matchArchiveReference(target, ref, [candidate]).reason).toBe(
    "reference-self-link",
  );
  expect(
    matchArchiveReference(
      source,
      { doi: null, text: "Ada Example. Synthetic Stud. 2026." },
      [candidate],
    ).target,
  ).toBeNull();
});
it("uses the existing strict identity rule only when structured citation supplies every field", () => {
  const candidate = literature(null);
  expect(
    matchArchiveReference(source, { doi: null, text: bibliography }, [
      candidate,
    ]),
  ).toMatchObject({ target: candidate, basis: "strict-fallback" });
  expect(
    referenceIdentityMetadata({
      doi: null,
      text: "@misc{a,title={Synthetic Study},author={Ada Example},year={2026}}",
    }),
  ).toBeNull();
  expect(
    matchArchiveReference(
      source,
      { doi: null, text: bibliography.replace("Ada Example", "A. Example") },
      [candidate],
    ).target,
  ).toBeNull();
});
