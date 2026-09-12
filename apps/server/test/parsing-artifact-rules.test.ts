import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { parseArtifactRef } from "@sciretriever/contracts";
import { TypeScriptParserArtifactRules } from "../src/parsing/artifact-rules.js";
import type { StagedParserArtifact } from "../src/parsing/ports.js";

const rules = new TypeScriptParserArtifactRules();

function artifact(
  content: string | Uint8Array,
  media_type = "text/markdown",
): StagedParserArtifact {
  const bytes = typeof content === "string" ? Buffer.from(content) : content;
  return {
    artifact: parseArtifactRef({
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byte_size: bytes.length,
      media_type,
    }),
    bytes,
  };
}

const resource = {
  reference: "assets/data.txt",
  content: artifact("Synthetic data\n", "text/plain"),
};
const valid = {
  markdown: artifact("# Synthetic paper\n\n![Data](assets/data.txt)\n"),
  resources: [resource],
};

it("validates normalized resource closure and Unicode Markdown in TypeScript", async () => {
  await expect(rules.validate(valid)).resolves.toBeUndefined();
  await expect(
    rules.validate({ markdown: artifact("# Cafe\u0301\n"), resources: [] }),
  ).resolves.toBeUndefined();
  await expect(
    rules.validate({ ...valid, resources: [] }),
  ).rejects.toMatchObject({ code: "parser-structure" });
});

const invalid = [
  { ...valid, resources: [] },
  { markdown: artifact("# No resources\n"), resources: [resource] },
  { ...valid, resources: [resource, resource] },
  { ...valid, resources: [{ ...resource, reference: "../data.txt" }] },
  {
    ...valid,
    resources: [{ ...resource, content: artifact("wrong", "image/png") }],
  },
  {
    ...valid,
    markdown: { ...valid.markdown, bytes: Buffer.from("Changed content\n") },
  },
  { ...valid, markdown: artifact(Buffer.from([0xff, 0xfe])) },
  { markdown: artifact("   "), resources: [] },
  {
    markdown: artifact("![Data](./assets/data.txt)\n"),
    resources: [resource],
  },
  {
    markdown: artifact("![image](assets/fake.png)\n"),
    resources: [
      {
        reference: "assets/fake.png",
        content: artifact("not a PNG", "image/png"),
      },
    ],
  },
  { markdown: artifact("![escape](file:///etc/passwd)\n"), resources: [] },
];

it.each(invalid.map((value, index) => ({ value, index })))(
  "rejects invalid TypeScript parser artifact case $index",
  async ({ value }) => {
    await expect(rules.validate(value)).rejects.toMatchObject({
      code: "parser-structure",
    });
  },
);

it("rejects an already-cancelled validation", async () => {
  await expect(
    rules.validate(
      { markdown: artifact("# Body\n"), resources: [] },
      AbortSignal.abort(),
    ),
  ).rejects.toMatchObject({ code: "parser-cancelled" });
});
