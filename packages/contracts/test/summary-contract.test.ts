import { expect, it } from "vitest";
import { parseSummaryContent, summaryContentBytes } from "../src/summary.js";
const evidence = {
  schema_version: 1,
  target_kind: "material",
  locator_scheme: "material-file-v1",
  material: {
    literature_id: "00000000-0000-0000-0000-000000000001",
    asset_id: "00000000-0000-0000-0000-000000000002",
    asset_sha256: "a".repeat(64),
    media_type: "application/pdf",
    byte_size: 100,
    artifact: {
      sha256: "a".repeat(64),
      byte_size: 100,
      media_type: "application/pdf",
    },
  },
  locator: { kind: "file" },
  content_sha256: "a".repeat(64),
};
const statement = {
  statement_id: "s1",
  category: "result",
  epistemic: "reported",
  text: "A source-bound finding.",
  conditions: [],
  quantity: null,
  evidence: [evidence],
};
it("retains long scientific conditions and hundreds of statements without historical count gates", () => {
  const text = "A quantitative comparison with context. ".repeat(50),
    content = {
      schema_version: 1,
      title: "Summary",
      statements: [
        {
          ...statement,
          text: text.repeat(3),
          conditions: [text],
          quantity: {
            value: text,
            unit: "relative yield",
            comparison_basis: text,
          },
        },
      ],
    };
  expect(parseSummaryContent(content).statements[0]!.quantity?.value).toBe(
    text,
  );
  const many = parseSummaryContent({
    ...content,
    statements: Array.from({ length: 300 }, (_, i) => ({
      ...statement,
      statement_id: `s${i}`,
    })),
  });
  expect(
    parseSummaryContent(
      JSON.parse(Buffer.from(summaryContentBytes(many)).toString()),
    ).statements,
  ).toHaveLength(300);
  for (const patch of [
    { evidence: [] },
    { quantity: { value: 5, unit: "g", comparison_basis: null } },
    { evidence: [{ ...evidence, content_sha256: "b".repeat(64) }] },
  ])
    expect(() =>
      parseSummaryContent({
        ...content,
        statements: [{ ...statement, ...patch }],
      }),
    ).toThrow();
  expect(() =>
    parseSummaryContent({ ...content, statements: [statement, statement] }),
  ).toThrow();
});
