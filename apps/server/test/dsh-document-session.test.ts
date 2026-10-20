import { createInputManifest, sha256 } from "@sciretriever/contracts";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { DshAgentRuntime } from "../src/agents/dsh/runtime.js";
import type {
  ModelRequest,
  ModelResponse,
} from "../src/agents/model-protocol.js";
import { analyzeDocumentSession } from "../src/analysis/knowledge-session.js";
import { readingImage } from "../src/analysis/reading-image.js";
import { coreProcessingFixture } from "./core-processing-fixture.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9e0AAAAASUVORK5CYII=",
  "base64",
);
const tool = (name: string, args: Record<string, unknown>): ModelResponse => ({
  message: {
    role: "assistant",
    parts: [],
    tool_calls: [{ id: randomUUID(), name, arguments: args }],
  },
  stop_reason: "tool_calls",
  provenance: {
    provider: "fixture",
    model: "vision",
    usage: { input_tokens: 10, output_tokens: 5 },
  },
});
it("requires full reading and saved images, then corrects forged citations in the same DSH conversation", async () => {
  const env = await coreProcessingFixture();
  let runtime: DshAgentRuntime | undefined;
  try {
    env.setText(
      "# Synthetic paper\n\nA measured yield of 60%.\n\n![Yield chart](images/chart.png)\n",
    );
    env.setResources([
      {
        reference: "images/chart.png",
        content: {
          bytes: png,
          artifact: {
            sha256: await sha256(png),
            byte_size: png.length,
            media_type: "image/png",
          },
        },
      },
    ]);
    await env.app.documentProcessing.parseDocuments(env.rawParseRequest);
    const corrected = await env.app.proofreading!.build({
      asset_id: env.asset.asset_id,
    });
    const parsed = await env.app.proofreadDocuments.publish({
      literature_id: env.parseRequest.literature_id,
      asset_id: env.asset.asset_id,
      proofread_id: corrected.version.proofread_id,
      expected_default_revision: null,
    });
    const described = await env.app.documentRead.describe({
      document_version_id: parsed.document.document_version_id,
    });
    const manifest = await createInputManifest([
      {
        input_id: "paper",
        literature_id: env.parseRequest.literature_id,
        material: described.document.source_material_ref,
        document: described.document,
        capabilities: [
          "material-file-v1",
          "document-segment-v1",
          "document-text-v1",
          "document-resources-v1",
        ],
        gaps: [],
      },
    ]);
    const segments = await env.app.documentRead.segments({
      document_version_id: parsed.document.document_version_id,
      section_id: null,
      limit: 200,
      cursor: null,
    });
    const measured = segments.segments[1]!.segment_id;
    expect(
      (
        await env.app.documentRead.slice({
          document_version_id: parsed.document.document_version_id,
          selector: { kind: "segment", segment_id: measured },
          max_bytes: 65536,
          continuation: null,
        })
      ).text,
    ).toContain("60%");
    const requests: ModelRequest[] = [];
    const draft = (id: string) => ({
      outcome: "completed",
      title: "研究总结",
      statements: [
        {
          statement_id: "s1",
          category: "result",
          epistemic: "reported",
          text: "原文报告收率为 60%。",
          conditions: [],
          quantity: { value: "60", unit: "%", comparison_basis: null },
          evidence_segment_ids: [id],
        },
      ],
    });
    runtime = new DshAgentRuntime([
      {
        role: "analysis",
        provider: "fixture",
        model: "vision",
        capabilities: ["structured_text", "tool_decision", "image_input"],
        reasoning: "default",
        stream: false,
        context_window_tokens: 1000000,
        max_output_tokens: 4096,
        adapter: {
          provider: "fixture",
          model: "vision",
          execute: async () => {
            throw new Error("Atomic fallback is forbidden");
          },
          executeModel: async (request, _options, _signal, lifecycle) => {
            requests.push(request);
            lifecycle?.onDispatched();
            const inputPart = request.messages[1]!.parts[0]!;
            if (!("text" in inputPart))
              throw new Error("Missing initial manifest");
            const input = JSON.parse(inputPart.text) as {
              resources: { resource_id: string }[];
            };
            const last = request.messages.at(-1)!;
            const text = last.parts
              .filter((p) => "text" in p)
              .map((p) => p.text)
              .join("");
            switch (requests.length) {
              case 1:
                return tool("submit_result", draft(measured));
              case 2:
                expect(text).toContain("knowledge-text-unread");
                return tool("read_document", { start_utf8: 0 });
              case 3:
                return tool("submit_result", draft(measured));
              case 4:
                expect(text).toContain("knowledge-images-unread");
                return tool("view_image", {
                  resource_id: input.resources[0]!.resource_id,
                });
              case 5: {
                const image = last.parts.find((p) => "data" in p);
                expect(
                  image && "data" in image ? Buffer.from(image.data) : null,
                ).toEqual(png);
                expect(image).toMatchObject({
                  media_type: "image/png",
                  width: 1,
                  height: 1,
                });
                return tool("search_document", { query: "60%" });
              }
              case 6:
                expect(text).toContain(measured);
                return tool("read_segments", { ids: [measured] });
              case 7:
                expect(text).toContain("60%");
                return tool("submit_result", draft("forged"));
              case 8:
                expect(text).toContain("knowledge-invalid-evidence");
                return tool("submit_result", draft(measured));
              default:
                throw new Error("Unexpected continuation");
            }
          },
        },
      },
    ]);
    const receipt = await analyzeDocumentSession(
      { input: manifest, purpose: "overview", question: null },
      env.app.documentRead,
      runtime,
      { provider: "fixture", model: "vision", max_output_tokens: 4096 },
      new AbortController().signal,
    );
    expect(receipt.content?.statements[0]?.text).toContain("60%");
    expect(requests).toHaveLength(8);
    expect(requests.every((r) => r.max_output_tokens === undefined)).toBe(true);
    expect(receipt).toMatchObject({ input_tokens: 80, output_tokens: 40 });
    expect(receipt.gaps).not.toContain("some-resource-content-unread");
    expect(
      requests
        .at(-1)!
        .messages.filter(
          (m) => m.role === "tool" && m.name === "submit_result",
        ),
    ).toHaveLength(3);
  } finally {
    await runtime?.close();
    await env.close();
  }
});
it("reads dimensions from saved raster headers and rejects corrupt resources", () => {
  expect(readingImage(png, "image/png")).toMatchObject({ width: 1, height: 1 });
  expect(() => readingImage(Buffer.from("not a jpeg"), "image/jpeg")).toThrow();
  expect(() => readingImage(png, "image/svg+xml")).toThrow();
  const jpeg = Buffer.from([
    255, 216, 255, 192, 0, 7, 8, 0, 30, 0, 40, 255, 217,
  ]);
  expect(readingImage(jpeg, "image/jpeg")).toMatchObject({
    width: 40,
    height: 30,
  });
  const webp = Buffer.alloc(30);
  webp.write("RIFF", 0);
  webp.write("WEBPVP8X", 8);
  webp.writeUIntLE(39, 24, 3);
  webp.writeUIntLE(29, 27, 3);
  expect(readingImage(webp, "image/webp")).toMatchObject({
    width: 40,
    height: 30,
  });
});
