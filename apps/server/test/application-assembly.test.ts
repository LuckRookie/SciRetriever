import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { createServer as createHttpsServer } from "node:https";
import { connect as tlsConnect } from "node:tls";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parseAsset, sha256 } from "@sciretriever/contracts";

import { createApplication } from "../src/bootstrap/application.js";
import { TypeScriptConfigurationOwner } from "../src/configuration/owner.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";

const execFileAsync = promisify(execFile);

describe("application composition", () => {
  it("constructs one shared offline object graph with stable ownership boundaries", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-assembly-"));
    const application = await createApplication(home);
    try {
      expect(application.database).toBeDefined();
      expect(application.files.root).toBe(join(home, "artifacts"));
      expect(application.observations).toBeDefined();
      expect(application.assets).toBeDefined();
      expect(application.references).toBeDefined();
      expect(application.metadata.statuses).toHaveLength(11);
      expect(
        application.metadata.statuses
          .filter((item) => item.ready)
          .map((item) => item.provider_name),
      ).toEqual([
        "crossref",
        "semantic-scholar",
        "arxiv",
        "openalex",
        "europe-pmc",
        "datacite",
        "core",
        "opencitations",
      ]);
      expect(
        application.metadata.statuses
          .filter((item) => !item.ready)
          .map((item) => [item.provider_name, item.failure_code]),
      ).toEqual([
        ["web-of-science", "missing-production-adapter"],
        ["elsevier", "credential-missing"],
        ["springer", "credential-missing"],
      ]);
      expect(application.agents.readiness("analysis").configured).toBe(false);
    } finally {
      await application.close();
    }
  });

  it("builds the selected model adapter from ordinary config and opaque credentials", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-configured-"));
    const directory = join(home, ".sciretriever");
    await mkdir(directory, { mode: 0o700 });
    await writeFile(
      join(directory, "config.toml"),
      [
        "[providers.openai]",
        'api = "openai-responses"',
        'base_url = "https://api.example.test"',
        "",
        '[models."openai/analysis-model"]',
        'reasoning = "medium"',
        "stream = false",
        "",
        "[analyze]",
        'model = "openai/analysis-model"',
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    await writeFile(
      join(directory, "credentials.toml"),
      [
        "[providers.openai]",
        'api_key = "offline-secret"',
        'origin = "https://api.example.test"',
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    await chmod(directory, 0o700);
    const application = await createApplication(home);
    try {
      expect(application.agents.readiness("analysis")).toEqual({
        configured: true,
        missing: [],
      });
      expect(application.agents.identity("analysis")).toEqual({
        role: "analysis",
        provider: "openai",
        model: "analysis-model",
        reasoning: "medium",
        stream: false,
      });
    } finally {
      await application.close();
    }
  });

  it("assembles the pure TypeScript remote parser only from an exact-origin MinerU grant", async () => {
    const home = await mkdtemp(
      join(tmpdir(), "sciretriever-parser-configured-"),
    );
    const directory = join(home, ".sciretriever");
    await mkdir(directory, { mode: 0o700 });
    await writeFile(
      join(directory, "config.toml"),
      [
        "[parsing]",
        'base_url = "https://parser.example.test/v1"',
        'connection_mode = "remote"',
        'model_identity = "mineru-fixture"',
        "remote_upload_authorized = true",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    await writeFile(
      join(directory, "credentials.toml"),
      [
        "[mineru]",
        'bearer_token = "offline-secret"',
        'origin = "https://parser.example.test"',
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    await chmod(directory, 0o700);
    const application = await createApplication(home);
    try {
      expect(application.parsing).not.toBeNull();
      expect(application.configuration.parsing).toEqual({
        base_url: "https://parser.example.test/v1",
        connection_mode: "remote",
        model_identity: "mineru-fixture",
        remote_upload_authorized: true,
      });
    } finally {
      await application.close();
    }
    await writeFile(
      join(directory, "config.toml"),
      [
        "[parsing]",
        'base_url = "https://parser.example.test/v1"',
        'connection_mode = "remote"',
        'model_identity = "mineru-fixture"',
        "remote_upload_authorized = false",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const unauthorized = await createApplication(home);
    try {
      expect(unauthorized.parsing).toBeNull();
    } finally {
      await unauthorized.close();
    }

    await rm(join(directory, "credentials.toml"));
    await writeFile(
      join(directory, "config.toml"),
      [
        "[parsing]",
        'base_url = "https://parser.example.test/v1"',
        'connection_mode = "remote"',
        'model_identity = "mineru-fixture"',
        "remote_upload_authorized = true",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const missingToken = await createApplication(home);
    try {
      expect(missingToken.parsing).toBeNull();
    } finally {
      await missingToken.close();
    }

    await writeFile(
      join(directory, "credentials.toml"),
      [
        "[mineru]",
        'bearer_token = "offline-secret"',
        'origin = "https://other.example.test"',
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const mismatchedOrigin = await createApplication(home);
    try {
      expect(mismatchedOrigin.parsing).toBeNull();
    } finally {
      await mismatchedOrigin.close();
    }
  });

  it("sends the MinerU token only to its configured TLS origin and rejects redirect before another request", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-parser-origin-"));
    const certificateDirectory = await mkdtemp(
      join(tmpdir(), "sciretriever-parser-tls-"),
    );
    const keyPath = join(certificateDirectory, "key.pem");
    const certificatePath = join(certificateDirectory, "cert.pem");
    await execFileAsync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      "/CN=parser.example.test",
      "-addext",
      "subjectAltName=DNS:parser.example.test",
      "-days",
      "1",
      "-keyout",
      keyPath,
      "-out",
      certificatePath,
    ]);
    const certificate = await readFile(certificatePath);
    let authorization: string | undefined;
    let requests = 0;
    const server = createHttpsServer(
      { key: await readFile(keyPath), cert: certificate },
      async (request, response) => {
        requests += 1;
        authorization = request.headers.authorization;
        for await (const _chunk of request) void _chunk;
        response.writeHead(302, {
          location: "https://redirect.example.test/parse",
        });
        response.end();
      },
    );
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(0, "127.0.0.1", resolveListen);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("TLS fixture unavailable");
    const origin = `https://parser.example.test:${address.port}`;
    const owner = new TypeScriptConfigurationOwner(home);
    const published = await owner.publish(
      `[parsing]\nbase_url = "${origin}/v1"\nconnection_mode = "remote"\nmodel_identity = "mineru-fixture"\nremote_upload_authorized = true\n`,
      "missing",
      ["parsing"],
    );
    await owner.credential(
      {
        namespace: "mineru",
        target: "mineru",
        kind: "set",
        value: "synthetic-parser-token",
      },
      published.revision,
    );
    const application = await createApplication(home, {
      metadataAssembly: {
        resolver: () => ["93.184.216.34"],
        connection: {
          connect: (options) =>
            createConnection({
              ...(options as { port: number }),
              host: "127.0.0.1",
            }),
          tlsConnect: (options) => tlsConnect({ ...options, ca: certificate }),
        },
      },
    });
    try {
      const pdf = workbenchPdf();
      await application.database.putLiterature(FIXTURE_LITERATURE);
      const stage = await application.files.stage();
      await stage.write(pdf);
      await application.files.publish(stage, "objects/remote-source.pdf");
      const asset = parseAsset({
        asset_id: "00000000-0000-0000-0000-000000000301",
        sha256: await sha256(pdf),
        size_bytes: pdf.byteLength,
        media_type: "application/pdf",
        path: "objects/remote-source.pdf",
      });
      await application.database.putLiteratureAsset({
        literature_asset_id: "00000000-0000-0000-0000-000000000302",
        literature_id: FIXTURE_LITERATURE.literature_id,
        asset,
        role: "primary-pdf",
        source_url: null,
        provenance: {
          provenance_id: "00000000-0000-0000-0000-000000000303",
          source_kind: "asset-provider",
          source_name: "fixture",
          source_record_id: null,
          observed_at: "2026-09-11T00:00:00Z",
          input_sha256: asset.sha256,
          parameters_sha256: null,
        },
      });
      await expect(
        application.parsing!.prepareCurrentPrimary(
          FIXTURE_LITERATURE.literature_id,
        ),
      ).rejects.toMatchObject({ code: "parser-unavailable" });
      expect(authorization).toBe("Bearer synthetic-parser-token");
      expect(requests).toBe(1);
      expect(
        (await application.library.detail(FIXTURE_LITERATURE.literature_id))
          .parser_result,
      ).toBeNull();
    } finally {
      await application.close();
      server.closeAllConnections();
      await new Promise<void>((resolveClose) =>
        server.close(() => resolveClose()),
      );
      await rm(home, { recursive: true, force: true });
      await rm(certificateDirectory, { recursive: true, force: true });
    }
  });
});
