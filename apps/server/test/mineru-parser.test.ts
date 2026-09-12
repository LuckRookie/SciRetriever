import { createHash } from "node:crypto";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { parseAsset, parseAssetId, sha256 } from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { TypeScriptConfigurationOwner } from "../src/configuration/owner.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";
import { MinerULoopbackParser } from "../src/parsing/backends/mineru/loopback.js";
import { NetworkBudgetCoordinator } from "../src/network/budget.js";

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries: readonly { name: string; bytes: Uint8Array }[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const header = Buffer.alloc(30 + name.length);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt32LE(crc32(entry.bytes), 14);
    header.writeUInt32LE(entry.bytes.length, 18);
    header.writeUInt32LE(entry.bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    name.copy(header, 30);
    local.push(header, Buffer.from(entry.bytes));

    const directory = Buffer.alloc(46 + name.length);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x800, 8);
    directory.writeUInt32LE(crc32(entry.bytes), 16);
    directory.writeUInt32LE(entry.bytes.length, 20);
    directory.writeUInt32LE(entry.bytes.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42);
    name.copy(directory, 46);
    central.push(directory);
    offset += header.length + entry.bytes.length;
  }
  const body = Buffer.concat([...local, ...central]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(Buffer.concat(central).length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([body, end]);
}

let fixtureData: Promise<{ pdf: Buffer; archive: Buffer }> | undefined;
function fixture(): Promise<{ pdf: Buffer; archive: Buffer }> {
  return (fixtureData ??= (async () => {
    const root = resolve("tests/fixtures/parsing/mineru");
    const names = [
      "document.md",
      "document_middle.json",
      "document_model.json",
      "document_content_list.json",
    ];
    const contents = await Promise.all(
      names.map(async (name) => {
        let bytes = await readFile(join(root, name));
        if (name === "document_middle.json") {
          const value = JSON.parse(bytes.toString()) as {
            pdf_info: unknown[];
          };
          value.pdf_info = value.pdf_info.slice(0, 1);
          bytes = Buffer.from(JSON.stringify(value));
        }
        if (name === "document_content_list.json") {
          const value = JSON.parse(bytes.toString()) as unknown[];
          bytes = Buffer.from(JSON.stringify(value.slice(0, 1)));
        }
        return { name, bytes };
      }),
    );
    const image = Buffer.from(
      (await readFile(join(root, "figure.png.base64"), "utf8")).trim(),
      "base64",
    );
    return {
      pdf: Buffer.from(workbenchPdf()),
      archive: zip([
        ...contents,
        { name: "images/figure.png", bytes: image },
        {
          name: "private/debug.json",
          bytes: Buffer.from("PRIVATE-ARCHIVE-SENTINEL"),
        },
      ]),
    };
  })());
}

async function server(mode = "valid") {
  const { archive } = await fixture();
  const calls: {
    path: string;
    method: string;
    body: Buffer;
    type: string;
    authorization: string | undefined;
  }[] = [];
  let entered: () => void = () => {};
  const waiting = new Promise<void>((resolveWaiting) => {
    entered = resolveWaiting;
  });
  const http = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request)
      chunks.push(Buffer.from(chunk as Uint8Array));
    calls.push({
      path: request.url!,
      method: request.method!,
      body: Buffer.concat(chunks),
      type: request.headers["content-type"] ?? "",
      authorization: request.headers.authorization,
    });
    if (mode === "delay") {
      entered();
      return;
    }
    let value: unknown;
    response.setHeader("content-type", "application/json");
    if (request.url === "/health") {
      if (mode === "redirect") {
        response.writeHead(302, { location: "http://192.0.2.1/secret" });
        response.end();
        return;
      }
      if (mode === "duplicate") {
        response.end(
          '{"status":"healthy","status":"healthy","version":"3.4.4","protocol_version":2}',
        );
        return;
      }
      value = {
        status: "healthy",
        version: mode === "version" ? "3.5.0" : "3.4.4",
        protocol_version: 2,
      };
    } else if (request.url === "/tasks" && request.method === "POST") {
      response.statusCode = 202;
      value = {
        task_id: mode === "task-path" ? "../escape" : "fixture-task",
        status: "pending",
      };
    } else if (request.url === "/tasks/fixture-task") {
      if (mode === "missing") {
        response.statusCode = 404;
        value = {};
      } else {
        value = {
          task_id: mode === "task-mismatch" ? "other-task" : "fixture-task",
          status: mode === "failed" ? "failed" : "completed",
        };
      }
    } else if (request.url === "/tasks/fixture-task/result") {
      response.setHeader("content-type", "application/zip");
      response.end(mode === "zip" ? Buffer.from("not a ZIP") : archive);
      return;
    } else {
      response.statusCode = 404;
      value = {};
    }
    response.end(JSON.stringify(value));
  });
  await new Promise<void>((resolveListen) =>
    http.listen(0, "127.0.0.1", resolveListen),
  );
  const address = http.address();
  if (!address || typeof address === "string")
    throw new Error("fixture server failed");
  return {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    waiting,
    close: async () => {
      http.closeAllConnections();
      await new Promise<void>((resolveClose, rejectClose) =>
        http.close((error) => (error ? rejectClose(error) : resolveClose())),
      );
    },
  };
}

function parser(baseUrl: string, coordinator = new NetworkBudgetCoordinator()) {
  return new MinerULoopbackParser({
    baseUrl,
    modelIdentity: "operator-vlm-model@fixture-revision",
    coordinator,
  });
}

async function parserRequest() {
  const { pdf } = await fixture();
  return {
    source_asset_id: parseAssetId("00000000-0000-0000-0000-000000000030"),
    source_sha256: await sha256(pdf),
    media_type: "application/pdf" as const,
    withContent: async <T>(
      consume: (chunks: AsyncIterable<Uint8Array>) => Promise<T>,
    ) =>
      consume(
        (async function* () {
          yield Uint8Array.from(pdf);
        })(),
      ),
  };
}

it("assembles the TypeScript MinerU client and publishes normalized artifacts", async () => {
  const fixtureServer = await server();
  const home = await mkdtemp(join(tmpdir(), "sciretriever-mineru-"));
  const owner = new TypeScriptConfigurationOwner(home);
  await owner.publish(
    `[parsing]\nbase_url = "${fixtureServer.url}"\nconnection_mode = "loopback"\nmodel_identity = "operator-vlm-model@fixture-revision"\n`,
    "missing",
    ["parsing"],
  );
  await writeFile(
    join(home, ".sciretriever/credentials.toml"),
    '[mineru]\nbearer_token = "must-not-reach-loopback"\norigin = "https://parser.example.test"\n',
    { mode: 0o600 },
  );
  const app = await createApplication(home);
  try {
    const { pdf } = await fixture();
    await app.database.putLiterature(FIXTURE_LITERATURE);
    const stage = await app.files.stage();
    await stage.write(pdf);
    await app.files.publish(stage, "objects/source.pdf");
    const asset = parseAsset({
      asset_id: (await parserRequest()).source_asset_id,
      sha256: await sha256(pdf),
      size_bytes: pdf.length,
      media_type: "application/pdf",
      path: "objects/source.pdf",
    });
    await app.database.putLiteratureAsset({
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
        observed_at: "2026-09-10T00:00:00Z",
        input_sha256: asset.sha256,
        parameters_sha256: null,
      },
    });
    const result = await app.parsing!.commitCurrentPrimary(
      await app.parsing!.prepareCurrentPrimary(
        FIXTURE_LITERATURE.literature_id,
      ),
    );
    expect(result).toMatchObject({
      page_count: 1,
      provenance: {
        parser_version: "mineru-ts-archive-v1",
        mode: "archive",
        model_identity: "operator-vlm-model@fixture-revision",
        provenance: { source_name: "mineru-ts", input_sha256: asset.sha256 },
      },
    });
    expect(result.resources.map((resource) => resource.reference)).toEqual([
      "images/figure.png",
    ]);
    expect(
      (await app.library.detail(FIXTURE_LITERATURE.literature_id))
        .parser_result,
    ).toEqual(result);
    expect(fixtureServer.calls.map((call) => [call.method, call.path])).toEqual(
      [
        ["GET", "/health"],
        ["POST", "/tasks"],
        ["GET", "/tasks/fixture-task"],
        ["GET", "/tasks/fixture-task/result"],
      ],
    );
    expect(
      fixtureServer.calls.every((call) => call.authorization === undefined),
    ).toBe(true);
    const submit = fixtureServer.calls[1]!;
    expect(submit.type).toMatch(
      /^multipart\/form-data; boundary=sciretriever-/u,
    );
    expect(submit.body.includes(pdf)).toBe(true);
    expect(submit.body.toString("latin1")).toContain(
      'name="backend"\r\n\r\nvlm-engine',
    );
    expect(submit.body.toString("latin1")).toContain(
      'name="return_original_file"\r\n\r\nfalse',
    );
    expect((await app.database.snapshotCounts()).tables.artifact_objects).toBe(
      3,
    );
    await app.literatureArtifacts.withArtifact(
      result.markdown,
      async (chunks) => {
        const parts: Buffer[] = [];
        for await (const chunk of chunks) parts.push(Buffer.from(chunk));
        const bytes = Buffer.concat(parts);
        expect(bytes.toString()).toContain("![Figure](images/figure.png)");
        expect(bytes.toString()).not.toContain("PRIVATE-ARCHIVE-SENTINEL");
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(
          result.markdown.sha256,
        );
      },
    );
  } finally {
    await app.close();
    await fixtureServer.close();
    await rm(home, { recursive: true, force: true });
  }
});

it("runs the loopback MinerU protocol entirely in TypeScript", async () => {
  const fixtureServer = await server();
  try {
    const result = await parser(fixtureServer.url).parse(await parserRequest());
    expect(result.page_count).toBe(1);
    expect(result.resources.map((item) => item.reference)).toEqual([
      "images/figure.png",
    ]);
  } finally {
    await fixtureServer.close();
  }
});

it.each([
  "version",
  "duplicate",
  "redirect",
  "task-path",
  "task-mismatch",
  "missing",
  "failed",
  "zip",
])("rejects invalid MinerU %s responses in TypeScript", async (mode) => {
  const http = await server(mode);
  try {
    await expect(
      parser(http.url).parse(await parserRequest()),
    ).rejects.toMatchObject({
      code: mode === "zip" ? "parser-structure" : "parser-unavailable",
    });
  } finally {
    await http.close();
  }
});

it("cancels pending HTTP and refuses unsafe loopback addresses", async () => {
  for (const url of [
    "http://192.0.2.1",
    "http://127.1",
    "http://2130706433",
    "https://127.0.0.1",
    "http://user:secret@127.0.0.1",
    "http://127.0.0.1/?token=private",
  ])
    expect(() => parser(url)).toThrow();
  const http = await server("delay");
  const abort = new AbortController();
  try {
    const pending = parser(http.url).parse(await parserRequest(), abort.signal);
    await Promise.race([
      http.waiting,
      pending.then(() => {
        throw new Error("parser completed before delayed health");
      }),
    ]);
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: "parser-cancelled" });
    expect(http.calls).toHaveLength(1);
  } finally {
    await http.close();
  }
});

it("rejects cancellation and invalid deadlines before upload", async () => {
  const http = await server();
  try {
    await expect(
      parser(http.url).parse(await parserRequest(), AbortSignal.abort()),
    ).rejects.toMatchObject({ code: "parser-cancelled" });
    expect(
      () =>
        new MinerULoopbackParser({
          baseUrl: http.url,
          modelIdentity: "fixture",
          coordinator: new NetworkBudgetCoordinator(),
          timeoutMs: 0,
        }),
    ).toThrow();
    expect(http.calls).toHaveLength(0);
  } finally {
    await http.close();
  }
});
