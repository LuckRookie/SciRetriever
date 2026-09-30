import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  extractionSpecHash,
  EXTRACTION_SCHEMA_URI,
  parseAsset,
  parseProvenance,
  sha256,
  type ExtractionSpec,
} from "@sciretriever/contracts";
import {
  createApplication,
  createQueryApplication,
} from "../src/bootstrap/application.js";
import { startQueryOnlyWorkbench } from "../src/bootstrap/workbench.js";
import { DocumentReadError } from "../src/document/read.js";
import {
  ExtractionSpecError,
  validateExtractionPayload,
  validateExtractionSpec,
} from "../src/extraction/spec.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";

const id = (n: number) =>
  `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const lit = FIXTURE_LITERATURE.literature_id;
const schema = {
  $schema: EXTRACTION_SCHEMA_URI,
  type: "object",
  properties: { value: { type: "string" }, child: { $ref: "#/$defs/node" } },
  required: ["value"],
  additionalProperties: false,
  $defs: {
    node: {
      type: "object",
      properties: {
        value: { type: "string" },
        child: { $ref: "#/$defs/node" },
      },
      required: ["value"],
      additionalProperties: false,
    },
  },
};
async function spec(
  override: Partial<ExtractionSpec> = {},
): Promise<ExtractionSpec> {
  const content = {
    schema_version: 1 as const,
    spec_id: "synthetic.measurement",
    spec_version: "1",
    record_meaning: "一条候选是一项合成观察。",
    output_schema: schema,
    field_instructions: ["value 原样记录"],
    inclusion_rules: ["仅使用已绑定输入"],
    missing_value_rules: ["缺失时不编造数值"],
    evidence_policy: {
      field_granularity: "file" as const,
      required_pointers: "record-root" as const,
      cross_input_relation: "optional" as const,
    },
    required_capabilities: ["material-file-v1" as const],
    ...override,
  };
  return { ...content, spec_sha256: await extractionSpecHash(content) };
}
async function fixture() {
  const home = await mkdtemp(
    join(tmpdir(), "sciretriever-extraction-prepare-"),
  );
  const app = await createApplication(home);
  try {
    await app.database.putLiterature(FIXTURE_LITERATURE);
    const assets = [];
    for (const n of [1, 2]) {
      const pdf = Buffer.concat([
        workbenchPdf(),
        Buffer.from(`\n% synthetic ${n}\n`),
      ]);
      const path = `objects/input-${n}.pdf`;
      const stage = await app.files.stage();
      await stage.write(pdf);
      await app.files.publish(stage, path);
      const asset = parseAsset({
        asset_id: id(900 + n),
        sha256: await sha256(pdf),
        size_bytes: pdf.length,
        media_type: "application/pdf",
        path,
      });
      await app.database.putLiteratureAsset({
        literature_asset_id: id(910 + n),
        literature_id: lit,
        asset,
        role: n === 1 ? "primary-pdf" : "supplementary-pdf",
        source_url: null,
        provenance: parseProvenance({
          provenance_id: id(920 + n),
          source_kind: "asset-provider",
          source_name: "synthetic",
          source_record_id: null,
          observed_at: "2026-09-29T00:00:00Z",
          input_sha256: asset.sha256,
          parameters_sha256: null,
        }),
      });
      assets.push(asset);
    }
    return {
      home,
      assets,
      closeApplication: () => app.close(),
      close: async () => {
        await app.close();
        await rm(home, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await app.close();
    await rm(home, { recursive: true, force: true });
    throw error;
  }
}

describe("external extraction preparation", () => {
  it("binds two exact raw PDFs of one Literature on v1 without parsing or a model", async () => {
    const env = await fixture();
    let query: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
    try {
      query = await createQueryApplication(env.home);
      const inputs = env.assets.map((asset, index) => ({
        input_id: `source-${index + 1}`,
        literature_id: lit,
        asset_id: asset.asset_id,
        asset_sha256: asset.sha256,
        document_version_id: null,
      }));
      const output = await query.extractionPreparation!.prepare({
        spec: await spec(),
        inputs,
      });
      expect(output.manifest.items.map((item) => item.input_id)).toEqual([
        "source-1",
        "source-2",
      ]);
      expect(
        output.manifest.items.map((item) => item.material?.asset_sha256),
      ).toEqual(env.assets.map((asset) => asset.sha256));
      expect(
        output.manifest.items.every(
          (item) =>
            item.document === null &&
            item.capabilities.includes("material-file-v1") &&
            item.gaps.includes("document-missing"),
        ),
      ).toBe(true);
      expect(output.missing_required_capabilities).toEqual([]);
      expect(
        await validateExtractionPayload(output.spec, {
          value: "α",
          child: { value: "β" },
        }),
      ).toMatchObject({ valid: true });
      expect(
        await validateExtractionPayload(output.spec, {
          value: "α",
          child: { value: 3 },
        }),
      ).toMatchObject({ valid: false });
      await expect(
        query.extractionPreparation!.prepare({
          spec: await spec(),
          inputs: [{ ...inputs[0], asset_sha256: "a".repeat(64) }],
        }),
      ).rejects.toMatchObject({ code: "stale-binding" });
    } finally {
      await query?.close();
      await env.close();
    }
  });
  it("rejects unknown keywords and remote refs, and keeps different Unicode payloads distinct", async () => {
    await expect(
      validateExtractionSpec(
        await spec({
          output_schema: {
            ...schema,
            patternProperties: { ".*": { type: "string" } },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "unsupported-schema" });
    await expect(
      validateExtractionSpec(
        await spec({
          output_schema: {
            ...schema,
            properties: { value: { $ref: "https://example.invalid/x" } },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "unsupported-schema" });
    const a = await spec({ record_meaning: "é" });
    const b = await spec({ record_meaning: "e\u0301" });
    expect(a.spec_sha256).not.toBe(b.spec_sha256);
    const arraySpec = await spec({
      output_schema: {
        $schema: EXTRACTION_SCHEMA_URI,
        type: "array",
        items: {
          type: "object",
          properties: { value: { type: ["string", "null"] } },
        },
      },
    });
    expect(
      await validateExtractionPayload(arraySpec, [
        { value: "one" },
        { value: null },
      ]),
    ).toMatchObject({ valid: true });
    expect(
      await validateExtractionPayload(arraySpec, [{ value: 3 }]),
    ).toMatchObject({ valid: false });
    const scalarSpec = await spec({
      output_schema: {
        $schema: EXTRACTION_SCHEMA_URI,
        type: "number",
      },
    });
    expect(await validateExtractionPayload(scalarSpec, 3)).toMatchObject({
      valid: true,
    });
    expect(await validateExtractionPayload(scalarSpec, "3")).toMatchObject({
      valid: false,
    });
    await expect(
      validateExtractionPayload(
        await spec({
          output_schema: {
            $schema: EXTRACTION_SCHEMA_URI,
            type: "object",
            patternProperties: { ".*": { type: "string" } },
          },
        }),
        { value: "x" },
      ),
    ).rejects.toMatchObject({ code: "unsupported-schema" });
  });
  it("bounds schema worker admission and cancels a queued validation", async () => {
    const valid = await spec();
    const stop = new AbortController();
    const checks = Array.from({ length: 80 }, (_, index) =>
      validateExtractionSpec(valid, index === 2 ? stop.signal : undefined),
    );
    stop.abort();
    const results = await Promise.allSettled(checks);
    expect(results[2]).toMatchObject({
      status: "rejected",
      reason: { code: "schema-cancelled" },
    });
    expect(
      results.some(
        (result) =>
          result.status === "rejected" &&
          result.reason instanceof Error &&
          (result.reason as ExtractionSpecError).code === "schema-busy",
      ),
    ).toBe(true);
  }, 15_000);
  it("validates repeated local-reference DAGs within worker limits and remains usable", async () => {
    const defs: Record<string, unknown> = { leaf: { type: "number" } };
    for (let level = 1; level <= 6; level++)
      defs[`level${level}`] = {
        type: "array",
        prefixItems: [
          { $ref: `#/$defs/${level === 1 ? "leaf" : `level${level - 1}`}` },
          { $ref: `#/$defs/${level === 1 ? "leaf" : `level${level - 1}`}` },
        ],
        minItems: 2,
        maxItems: 2,
      };
    const repeated = await spec({
      output_schema: {
        $schema: EXTRACTION_SCHEMA_URI,
        $defs: defs,
        $ref: "#/$defs/level6",
      },
    });
    const tree = (level: number, leaf: unknown): unknown =>
      level === 0 ? leaf : [tree(level - 1, leaf), tree(level - 1, leaf)];
    expect(await validateExtractionPayload(repeated, tree(6, 7))).toMatchObject(
      { valid: true },
    );
    expect(
      await validateExtractionPayload(repeated, tree(6, "invalid")),
    ).toMatchObject({ valid: false });
    expect(await validateExtractionSpec(await spec())).toMatchObject({
      schema_version: 1,
    });
  });
  it("terminates a schema compilation when its deadline expires", async () => {
    const nativeTimeout = setTimeout;
    const timer = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((
        handler: TimerHandler,
        delay?: number,
        ...args: unknown[]
      ) =>
        nativeTimeout(
          handler,
          delay === 3000 ? 1 : delay,
          ...args,
        )) as typeof setTimeout);
    try {
      await expect(validateExtractionSpec(await spec())).rejects.toMatchObject({
        code: "schema-timeout",
      });
    } finally {
      timer.mockRestore();
    }
  });
  it("reports an implicit segment gap, missing material and corrupt bytes distinctly", async () => {
    const env = await fixture();
    let query: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
    try {
      query = await createQueryApplication(env.home);
      const asset = env.assets[0]!;
      const selected = {
        input_id: "source-1",
        literature_id: lit,
        asset_id: asset.asset_id,
        asset_sha256: asset.sha256,
        document_version_id: null,
      };
      const prepared = await query.extractionPreparation!.prepare({
        spec: await spec({
          required_capabilities: [],
          evidence_policy: {
            field_granularity: "segment",
            required_pointers: "record-root",
            cross_input_relation: "optional",
          },
        }),
        inputs: [selected],
      });
      expect(prepared.missing_required_capabilities).toEqual([
        { input_id: "source-1", capabilities: ["document-segment-v1"] },
      ]);
      await expect(
        query.extractionPreparation!.prepare({
          spec: await spec(),
          inputs: [{ ...selected, asset_id: id(999) }],
        }),
      ).rejects.toMatchObject({ code: "input-missing" });
      await writeFile(
        join(env.home, "artifacts", "objects/input-1.pdf"),
        "corrupt",
      );
      await expect(
        query.extractionPreparation!.prepare({
          spec: await spec(),
          inputs: [selected],
        }),
      ).rejects.toMatchObject({ code: "input-integrity" });
    } finally {
      await query?.close();
      await env.close();
    }
  });
  it("preserves document integrity errors and waits for in-flight preparation during reentrant close", async () => {
    const env = await fixture();
    let query: Awaited<ReturnType<typeof createQueryApplication>> | undefined;
    try {
      query = await createQueryApplication(env.home);
      const asset = env.assets[0]!;
      const selected = {
        input_id: "source-1",
        literature_id: lit,
        asset_id: asset.asset_id,
        asset_sha256: asset.sha256,
        document_version_id: null,
      };
      vi.spyOn(query.documentRead!, "default").mockRejectedValueOnce(
        new DocumentReadError("document-integrity"),
      );
      await expect(
        query.extractionPreparation!.prepare({
          spec: await spec(),
          inputs: [selected],
        }),
      ).rejects.toMatchObject({ code: "input-integrity" });
      let entered!: () => void;
      let release!: () => void;
      const reading = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const actualMaterial = query.documentRead!.materialEvidence.bind(
        query.documentRead,
      );
      vi.spyOn(query.documentRead!, "materialEvidence").mockImplementation(
        async (value, signal) => {
          entered();
          await gate;
          return actualMaterial(value, signal);
        },
      );
      const operation = query.extractionPreparation!.prepare({
        spec: await spec(),
        inputs: [selected],
      });
      await reading;
      const first = query.close();
      const second = query.close();
      expect(first).toBe(second);
      let closed = false;
      void first.then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);
      release();
      await expect(operation).rejects.toMatchObject({
        code: "preparation-cancelled",
      });
      await first;
      query = undefined;
    } finally {
      await query?.close();
      await env.close();
    }
  });
  it("serves the real preparation over loopback HTTP and rejects duplicate JSON keys", async () => {
    const env = await fixture();
    let workbench:
      | Awaited<ReturnType<typeof startQueryOnlyWorkbench>>
      | undefined;
    try {
      await env.closeApplication();
      workbench = await startQueryOnlyWorkbench({
        home: env.home,
        assets: new Map(),
      });
      const asset = env.assets[0]!;
      const request = {
        protocol_version: 1,
        request: {
          spec: await spec(),
          inputs: [
            {
              input_id: "source-1",
              literature_id: lit,
              asset_id: asset.asset_id,
              asset_sha256: asset.sha256,
              document_version_id: null,
            },
          ],
        },
      };
      const response = await fetch(
        `${workbench.origin}/api/v1/query/extraction-prepare`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
        },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        result: { manifest: { items: [{ input_id: "source-1" }] } },
      });
      const duplicate = await fetch(
        `${workbench.origin}/api/v1/query/extraction-prepare`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: '{"protocol_version":1,"request":{"inputs":[],"inputs":[]}}',
        },
      );
      expect(duplicate.status).toBe(400);
    } finally {
      await workbench?.close();
      await rm(env.home, { recursive: true, force: true });
    }
  });
  it("cancels an in-flight HTTP preparation when its client disconnects", async () => {
    const env = await fixture();
    let workbench:
      | Awaited<ReturnType<typeof startQueryOnlyWorkbench>>
      | undefined;
    try {
      await env.closeApplication();
      workbench = await startQueryOnlyWorkbench({
        home: env.home,
        assets: new Map(),
      });
      const asset = env.assets[0]!;
      let entered!: () => void;
      const reading = new Promise<void>((resolve) => {
        entered = resolve;
      });
      vi.spyOn(
        workbench.application.documentRead!,
        "materialEvidence",
      ).mockImplementation(async (_request, signal) => {
        entered();
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          else
            signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new DocumentReadError("document-cancelled");
      });
      const stop = new AbortController();
      const pending = fetch(
        `${workbench.origin}/api/v1/query/extraction-prepare`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            protocol_version: 1,
            request: {
              spec: await spec(),
              inputs: [
                {
                  input_id: "source-1",
                  literature_id: lit,
                  asset_id: asset.asset_id,
                  asset_sha256: asset.sha256,
                  document_version_id: null,
                },
              ],
            },
          }),
          signal: stop.signal,
        },
      );
      await reading;
      stop.abort();
      await expect(pending).rejects.toThrow();
      await workbench.close();
      workbench = undefined;
    } finally {
      await workbench?.close();
      await rm(env.home, { recursive: true, force: true });
    }
  });
});
