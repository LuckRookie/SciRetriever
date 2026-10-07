import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAsset, parseAssetId, sha256 } from "@sciretriever/contracts";
import { executeProbeText } from "../src/agents/probe.js";
import type { AgentTransport } from "../src/agents/protocol.js";
import { createApplication } from "../src/bootstrap/application.js";
import { TypeScriptConfigurationOwner } from "../src/configuration/owner.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";

const TOKEN = "synthetic-current-credential-token";

describe("current Application credential authorization", () => {
  it("allows an admitted request to finish but blocks a new request after revocation", async () => {
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-current-credential-"),
    );
    const owner = new TypeScriptConfigurationOwner(home);
    const payload = `[providers.fixture]
api = "openai-responses"
base_url = "https://fixture.example.test/v1"
[models."fixture/model"]
image = false
stream = false
[analyze]
model = "fixture/model"
metadata_max_output_tokens = 512
content_max_output_tokens = 2048
max_input_bytes = 1000000
max_chunk_bytes = 100000
max_chunk_count = 16
max_total_llm_requests = 8
max_total_output_tokens = 20000
`;
    let markEntered!: () => void;
    let releaseRequest!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const inFlight = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    const requests: Array<{
      readonly endpoint: string;
      readonly headers: readonly (readonly [string, string])[];
    }> = [];
    const transport: AgentTransport = async (request) => {
      requests.push({ endpoint: request.endpoint, headers: request.headers });
      if (requests.length === 1) {
        markEntered();
        await inFlight;
      }
      return {
        status: 200,
        headers: [["content-type", "application/json"]],
        body: new TextEncoder().encode(
          JSON.stringify({
            object: "response",
            status: "completed",
            model: "model",
            output: [
              {
                type: "message",
                status: "completed",
                role: "assistant",
                content: [{ type: "output_text", text: '{"ok":true}' }],
              },
            ],
            usage: { input_tokens: 4, output_tokens: 2 },
          }),
        ),
      };
    };
    let application: Awaited<ReturnType<typeof createApplication>> | undefined;
    try {
      const published = await owner.publish(payload, "missing", [
        "providers",
        "models",
        "analyze",
      ]);
      await owner.credential(
        {
          namespace: "model",
          target: "fixture",
          kind: "set",
          value: TOKEN,
        },
        published.revision,
      );
      application = await createApplication(home, {
        configurationOwner: owner,
        agentTransportFactory: () => transport,
      });

      const admitted = executeProbeText(application.agents, "analysis");
      await entered;
      const current = await owner.read();
      await owner.credential(
        { namespace: "model", target: "fixture", kind: "remove" },
        current.revision,
      );
      releaseRequest();
      await expect(admitted).resolves.toMatchObject({ value: { ok: true } });
      expect(
        requests[0]?.headers.find(([name]) => name === "authorization")?.[1],
      ).toBe(`Bearer ${TOKEN}`);

      await expect(
        executeProbeText(application.agents, "analysis"),
      ).rejects.toMatchObject({
        name: "AgentFailure",
        code: "agent-credentials",
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.endpoint).toBe(
        "https://fixture.example.test/v1/responses",
      );
    } finally {
      releaseRequest();
      await application?.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("refreshes credentialed Metadata requests without blocking a public provider", async () => {
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-current-metadata-"),
    );
    const owner = new TypeScriptConfigurationOwner(home);
    const requests: Array<{
      readonly provider: string;
      readonly headers: Readonly<Record<string, string>>;
    }> = [];
    let application: Awaited<ReturnType<typeof createApplication>> | undefined;
    try {
      const published = await owner.publish(
        '[sources.metadata]\nmode = "custom"\nproviders = ["core", "openalex"]\nlimit = 7\n',
        "missing",
        ["sources"],
      );
      await owner.credential(
        {
          namespace: "source",
          target: "core",
          kind: "set",
          fields: { api_key: "synthetic-core-token-one" },
        },
        published.revision,
      );
      application = await createApplication(home, {
        configurationOwner: owner,
        metadataAssembly: {
          transportFactory: (provider) => ({
            request: async (_url, options = {}) => {
              const headers = options.headers ?? {};
              requests.push({ provider, headers });
              if (provider === "core") {
                if (!headers.authorization)
                  throw new Error("fixture requires authorized Core request");
                return { totalHits: 0, limit: 100, offset: 0, results: [] };
              }
              if (provider === "openalex")
                return { results: [], meta: { next_cursor: null } };
              throw new Error("unexpected provider request");
            },
          }),
        },
      });
      const query = {
        query: "synthetic query",
        year_from: null,
        year_to: null,
      } as const;

      const first = await application.metadata.service.searchTopicProvider(
        "core",
        query,
        1,
      );
      expect(first.outcome).toBe("EXHAUSTED");
      expect(requests[0]?.headers.authorization).toBe(
        "Bearer synthetic-core-token-one",
      );

      const current = await owner.read();
      await owner.credential(
        {
          namespace: "source",
          target: "elsevier",
          kind: "set",
          fields: { api_key: "synthetic-unrelated-source-token" },
        },
        current.revision,
      );
      await application.metadata.service.searchTopicProvider("core", query, 1);
      expect(requests[1]?.headers.authorization).toBe(
        "Bearer synthetic-core-token-one",
      );

      const afterUnrelated = await owner.read();
      await owner.credential(
        {
          namespace: "source",
          target: "core",
          kind: "set",
          fields: { api_key: "synthetic-core-token-two" },
        },
        afterUnrelated.revision,
      );
      await application.metadata.service.searchTopicProvider("core", query, 1);
      expect(requests[2]?.headers.authorization).toBe(
        "Bearer synthetic-core-token-two",
      );

      const beforeRevocation = await owner.read();
      await owner.credential(
        { namespace: "source", target: "core", kind: "remove" },
        beforeRevocation.revision,
      );
      const revoked = await application.metadata.service.searchTopicProvider(
        "core",
        query,
        1,
      );
      expect(revoked.outcome).toBe("FAILED");
      expect(requests[3]?.headers.authorization).toBeUndefined();

      const publicResult =
        await application.metadata.service.searchTopicProvider(
          "openalex",
          query,
          1,
        );
      expect(publicResult.outcome).toBe("EXHAUSTED");
      expect(requests[4]?.headers.authorization).toBeUndefined();
    } finally {
      await application?.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("locally blocks a revoked required Metadata credential while keeping public requests anonymous", async () => {
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-revoked-metadata-credential-"),
    );
    const owner = new TypeScriptConfigurationOwner(home);
    const requests: Array<{
      readonly provider: string;
      readonly headers: Readonly<Record<string, string>>;
    }> = [];
    let application: Awaited<ReturnType<typeof createApplication>> | undefined;
    try {
      const published = await owner.publish(
        '[sources.metadata]\nmode = "custom"\nproviders = ["elsevier", "openalex"]\nlimit = 7\n',
        "missing",
        ["sources"],
      );
      await owner.credential(
        {
          namespace: "source",
          target: "elsevier",
          kind: "set",
          fields: { api_key: "synthetic-elsevier-token" },
        },
        published.revision,
      );
      application = await createApplication(home, {
        configurationOwner: owner,
        metadataAssembly: {
          transportFactory: (provider) => ({
            request: async (_url, options = {}) => {
              const headers = options.headers ?? {};
              requests.push({ provider, headers });
              if (provider === "openalex")
                return { results: [], meta: { next_cursor: null } };
              throw new Error("revoked required credential reached transport");
            },
          }),
        },
      });

      const current = await owner.read();
      await owner.credential(
        { namespace: "source", target: "elsevier", kind: "remove" },
        current.revision,
      );
      const query = {
        query: "synthetic query",
        year_from: null,
        year_to: null,
      } as const;
      const revoked = await application.metadata.service.searchTopicProvider(
        "elsevier",
        query,
        1,
      );
      expect(revoked).toMatchObject({
        outcome: "FAILED",
        failure: { code: "metadata-provider-credential-unavailable" },
      });
      expect(requests).toEqual([]);

      const publicResult =
        await application.metadata.service.searchTopicProvider(
          "openalex",
          query,
          1,
        );
      expect(publicResult.outcome).toBe("EXHAUSTED");
      expect(requests).toEqual([{ provider: "openalex", headers: {} }]);
    } finally {
      await application?.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rechecks authorized Acquisition credentials for each download on one Application", async () => {
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-current-acquisition-"),
    );
    const owner = new TypeScriptConfigurationOwner(home);
    const requests: Array<Readonly<Record<string, string>>> = [];
    let application: Awaited<ReturnType<typeof createApplication>> | undefined;
    try {
      const published = await owner.publish(
        '[sources.acquisition]\nmode = "custom"\nproviders = ["core"]\n',
        "missing",
        ["sources"],
      );
      await owner.credential(
        {
          namespace: "source",
          target: "core",
          kind: "set",
          fields: { api_key: "synthetic-core-token-one" },
        },
        published.revision,
      );
      application = await createApplication(home, {
        configurationOwner: owner,
        acquisitionAssembly: {
          authorizedTransportFactory: () => ({
            request: async (_url, options = {}) => {
              requests.push(options.headers ?? {});
              return { status: 404, headers: [], body: new Uint8Array() };
            },
          }),
        },
      });
      const source = application.acquisition.sources.find(
        (item) => item.source_name === "core",
      );
      expect(source).toBeDefined();
      const candidates = await source!.discover({
        identifiers: [{ namespace: "core-work", value: "fixture-work" }],
      });
      expect(candidates).toHaveLength(1);

      expect(await source!.download_candidate!(candidates[0]!)).toMatchObject({
        kind: "miss",
        reason: "http-404",
      });
      expect(requests[0]?.authorization).toBe(
        "Bearer synthetic-core-token-one",
      );

      const current = await owner.read();
      await owner.credential(
        {
          namespace: "source",
          target: "elsevier",
          kind: "set",
          fields: { api_key: "synthetic-unrelated-source-token" },
        },
        current.revision,
      );
      await source!.download_candidate!(candidates[0]!);
      expect(requests[1]?.authorization).toBe(
        "Bearer synthetic-core-token-one",
      );

      const beforeRotation = await owner.read();
      await owner.credential(
        {
          namespace: "source",
          target: "core",
          kind: "set",
          fields: { api_key: "synthetic-core-token-two" },
        },
        beforeRotation.revision,
      );
      await source!.download_candidate!(candidates[0]!);
      expect(requests[2]?.authorization).toBe(
        "Bearer synthetic-core-token-two",
      );

      const beforeRevocation = await owner.read();
      await owner.credential(
        { namespace: "source", target: "core", kind: "remove" },
        beforeRevocation.revision,
      );
      await expect(
        source!.download_candidate!(candidates[0]!),
      ).rejects.toMatchObject({
        code: "http-response-failed",
        retryable: false,
        cause: { failure: { code: "authentication" } },
      });
      expect(requests).toHaveLength(3);
    } finally {
      await application?.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rechecks the remote MinerU bearer token before each parse request", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-current-mineru-"));
    const owner = new TypeScriptConfigurationOwner(home);
    const requests: Array<{ readonly authorization: string | undefined }> = [];
    let application: Awaited<ReturnType<typeof createApplication>> | undefined;
    try {
      const published = await owner.publish(
        '[parsing]\nbase_url = "https://parser.example.test"\nconnection_mode = "remote"\nmodel_identity = "synthetic-parser"\nremote_upload_authorized = true\n',
        "missing",
        ["parsing"],
      );
      await owner.credential(
        {
          namespace: "mineru",
          target: "mineru",
          kind: "set",
          value: "synthetic-mineru-token-one",
        },
        published.revision,
      );
      const pdf = Buffer.from(workbenchPdf());
      const assetId = parseAssetId("00000000-0000-0000-0000-000000000030");
      const assetHash = await sha256(pdf);
      application = await createApplication(home, {
        configurationOwner: owner,
        mineruTransportFactory: () => ({
          request: async (_url, options) => {
            requests.push({ authorization: options.headers.authorization });
            return { status: 401, headers: [], body: new Uint8Array() };
          },
        }),
      });
      await application.database.putLiterature(FIXTURE_LITERATURE);
      const stage = await application.files.stage();
      await stage.write(pdf);
      await application.files.publish(stage, "objects/source.pdf");
      const asset = parseAsset({
        asset_id: assetId,
        sha256: assetHash,
        size_bytes: pdf.length,
        media_type: "application/pdf",
        path: "objects/source.pdf",
      });
      await application.database.putLiteratureAsset({
        literature_asset_id: "00000000-0000-0000-0000-000000000031",
        literature_id: FIXTURE_LITERATURE.literature_id,
        asset,
        role: "primary-pdf",
        source_url: null,
        provenance: {
          provenance_id: "00000000-0000-0000-0000-000000000032",
          source_kind: "asset-provider",
          source_name: "fixture",
          source_record_id: null,
          observed_at: "2026-09-28T00:00:00Z",
          input_sha256: assetHash,
          parameters_sha256: null,
        },
      });

      await expect(
        application.parsing!.prepareCurrentPrimary(
          FIXTURE_LITERATURE.literature_id,
        ),
      ).rejects.toMatchObject({ code: "parser-unavailable" });
      expect(requests[0]?.authorization).toBe(
        "Bearer synthetic-mineru-token-one",
      );

      const current = await owner.read();
      await owner.credential(
        {
          namespace: "mineru",
          target: "mineru",
          kind: "set",
          value: "synthetic-mineru-token-two",
        },
        current.revision,
      );
      await expect(
        application.parsing!.prepareCurrentPrimary(
          FIXTURE_LITERATURE.literature_id,
        ),
      ).rejects.toMatchObject({ code: "parser-unavailable" });
      expect(requests[1]?.authorization).toBe(
        "Bearer synthetic-mineru-token-two",
      );

      const beforeRevocation = await owner.read();
      await owner.credential(
        { namespace: "mineru", target: "mineru", kind: "remove" },
        beforeRevocation.revision,
      );
      await expect(
        application.parsing!.prepareCurrentPrimary(
          FIXTURE_LITERATURE.literature_id,
        ),
      ).rejects.toMatchObject({ code: "parser-unavailable" });
      expect(requests).toHaveLength(2);
    } finally {
      await application?.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});
