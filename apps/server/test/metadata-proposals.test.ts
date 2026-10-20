import { expect, it } from "vitest";
import { validateMetadataProposals } from "../src/literature/metadata-proposals.js";
const fragments = [
  {
    fragment_id: "p1",
    page: 1,
    role: "front-matter",
    text: "Synthetic paper DOI: 10.1234/example",
  },
  {
    fragment_id: "p2",
    page: 1,
    role: "abstract",
    text: "A synthetic experiment.",
  },
];
it("binds legal proposals to the supplied fixed fragments and rejects unsupported DOI claims", () => {
  const result = validateMetadataProposals(
    {
      proposals: [
        { field: "title", value: "Synthetic paper", fragment_ids: ["p1"] },
        {
          field: "identifiers",
          value: [{ namespace: "doi", value: "10.1234/imaginary" }],
          fragment_ids: ["p1"],
        },
        {
          field: "abstract",
          value: "A synthetic experiment.",
          fragment_ids: ["missing"],
        },
      ],
    },
    "fixed-document",
    fragments,
  );
  expect(result.candidates).toHaveLength(1);
  expect(result.candidates[0]?.evidence).toEqual({
    source: "proofread",
    document_version_id: "fixed-document",
    fragment_ids: ["p1"],
  });
  expect(result.discarded).toEqual([
    { field: "identifiers", reason: "metadata-doi-not-in-evidence" },
    { field: "abstract", reason: "metadata-evidence-invalid" },
  ]);
  expect(
    validateMetadataProposals(
      {
        proposals: [
          {
            field: "identifiers",
            value: [{ namespace: "doi", value: "10.1234/example" }],
            fragment_ids: ["p1"],
          },
        ],
      },
      "fixed-document",
      fragments,
    ).candidates,
  ).toHaveLength(1);
});
it("rejects invented enums, duplicate fields, unknown fields and malformed DOI", () => {
  expect(() =>
    validateMetadataProposals(
      {
        proposals: [
          { field: "article_kind", value: "dataset", fragment_ids: ["p1"] },
        ],
      },
      "d",
      fragments,
    ),
  ).toThrow();
  expect(() =>
    validateMetadataProposals(
      {
        proposals: [
          { field: "document_type", value: "article", fragment_ids: ["p1"] },
        ],
      },
      "d",
      fragments,
    ),
  ).toThrow();
  const proposal = { field: "title", value: "x", fragment_ids: ["p1"] };
  expect(() =>
    validateMetadataProposals(
      { proposals: [proposal, proposal] },
      "d",
      fragments,
    ),
  ).toThrow();
  expect(
    validateMetadataProposals(
      {
        proposals: [
          {
            field: "identifiers",
            value: [{ namespace: "doi", value: "invented" }],
            fragment_ids: ["p1"],
          },
        ],
      },
      "d",
      fragments,
    ).discarded,
  ).toEqual([{ field: "identifiers", reason: "metadata-doi-invalid" }]);
});

it("does not accept a DOI that is only a prefix of the cited identifier", () => {
  const value = {
    proposals: [
      {
        field: "identifiers",
        value: [{ namespace: "doi", value: "10.1234/example" }],
        fragment_ids: ["p1"],
      },
    ],
  };
  expect(
    validateMetadataProposals(value, "fixed", [
      {
        fragment_id: "p1",
        page: 1,
        role: "front-matter",
        text: "DOI: 10.1234/example-longer.",
      },
    ]).discarded,
  ).toHaveLength(1);
  expect(
    validateMetadataProposals(value, "fixed", [
      {
        fragment_id: "p1",
        page: 1,
        role: "front-matter",
        text: "(https://doi.org/10.1234/example).",
      },
    ]).candidates,
  ).toHaveLength(1);
});
