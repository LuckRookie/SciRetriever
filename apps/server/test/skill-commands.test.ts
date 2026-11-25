import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, it, vi } from "vitest";
import {
  createApplication,
  createQueryApplication,
} from "../src/bootstrap/application.js";
import { deviceBusinessRoutes } from "../src/bootstrap/device-routes.js";
import { SdkTransportAdapter } from "../src/mcp/transport.js";
import { startWorkbenchHttp } from "../src/workbench/http.js";
import { ProductionWorkbenchSession } from "../src/workbench/production-session.js";
import { workbenchPdf } from "../src/workbench/synthetic-fixture.js";
import { workbenchTestAccess } from "./workbench-auth-fixture.js";

const execute = promisify(execFile);
const repository = resolve(new URL("../../..", import.meta.url).pathname);
const skill = join(repository, "skills/sciretriever");
async function commands(name: string) {
  return Array.from(
    (await readFile(join(skill, name), "utf8")).matchAll(
      /```bash\n([\s\S]*?)```/gu,
    ),
    (match) => match[1]!,
  );
}

it("executes every skill command against a synthetic production HTTP library and downloads its built package", async () => {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-skill-commands-"));
  const artifact = join(home, "artifacts-download");
  const { buildAgentAccess } = (await import(
    new URL("../../../scripts/build-agent-access.mjs", import.meta.url).href
  )) as {
    buildAgentAccess(source: string, target: string): Promise<string>;
  };
  await buildAgentAccess(skill, artifact);
  const app = await createApplication(home, {
    indexRefreshIntervalMs: null,
    importSessions: { maintain: true },
    metadata: {
      topic_search_ports: [],
      lookup_ports: [],
      reference_query_ports: [],
    },
  });
  const query = await createQueryApplication(home);
  const session = new ProductionWorkbenchSession(null, undefined);
  const server = await startWorkbenchHttp({
    session,
    access: workbenchTestAccess,
    assets: new Map([["/", { contentType: "text/html", body: "fixture" }]]),
    devices: {
      service: app.deviceConnections,
      routes: deviceBusinessRoutes(app, query, pathToFileURL(artifact + "/")),
    },
  });
  const client = new Client({ name: "synthetic-skill-check", version: "1" });
  try {
    const CONFIG_DIR = join(home, "connection");
    const WORK_DIR = join(home, "work");
    const FILES_DIR = join(home, "export");
    const PAIRING_FILE = join(home, "pairing-code");
    await mkdir(join(FILES_DIR, "files"), { recursive: true });
    // Deliberately pre-existing loose permissions must also be tightened.
    await mkdir(CONFIG_DIR, { mode: 0o755 });
    await writeFile(join(CONFIG_DIR, "curl.conf"), "", { mode: 0o644 });
    const paired = await app.deviceConnections.create({
      address: server.origin,
      name: "Synthetic skill command check",
      purposes: ["intake", "read"],
    });
    await writeFile(PAIRING_FILE, paired.connection_code, { mode: 0o600 });
    const variables = {
      CONFIG_DIR,
      WORK_DIR,
      FILES_DIR,
      PAIRING_FILE,
      SKILL_DIR: join(WORK_DIR, "skill/sciretriever"),
    };
    let secret = "";
    let output = "";
    const shell = async (source: string, code = 0) => {
      const result = await execute("bash", ["-eu", "-c", source], {
        cwd: repository,
        env: variables,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      }).then(
        (value) => ({ ...value, code: 0 }),
        (error: { stdout: string; stderr: string; code: number }) => ({
          stdout: error.stdout,
          stderr: error.stderr,
          code: error.code,
        }),
      );
      output += result.stdout + result.stderr;
      if (secret) expect(output.includes(secret)).toBe(false);
      expect(output.includes(paired.connection_code)).toBe(false);
      expect(result.code).toBe(code);
      return result.stdout;
    };
    const connection = await commands("connect.md");
    expect(connection).toHaveLength(2);
    expect(await shell(connection[0]!)).toBe("连接已保存。\n");
    const privateConfig = await readFile(join(CONFIG_DIR, "curl.conf"), "utf8");
    secret = /Bearer ([^"\n]+)/u.exec(privateConfig)![1]!;
    expect(secret.length > 0).toBe(true);
    expect(output.includes(secret)).toBe(false);
    expect((await stat(CONFIG_DIR)).mode & 0o777).toBe(0o700);
    expect((await stat(join(CONFIG_DIR, "curl.conf"))).mode & 0o777).toBe(
      0o600,
    );
    await shell(connection[1]!);
    const reference = JSON.parse(
      await readFile(join(WORK_DIR, "instructions.json"), "utf8"),
    ).result;
    expect(reference.semantics.join(" ")).toContain("metadata_only");
    const guide = await fetch(server.origin + "/api/v1/intake/agent-guide", {
      headers: { Authorization: `Bearer ${secret}` },
    });
    expect(guide.status).toBe(200);
    expect(await guide.text()).toBe(
      await readFile(join(artifact, "agent-guide.md"), "utf8"),
    );
    expect(await readFile(join(WORK_DIR, "skill.zip"))).toEqual(
      await readFile(join(artifact, "skill.zip")),
    );
    expect(
      await readFile(join(variables.SKILL_DIR, "scripts/upload_files.py")),
    ).toEqual(await readFile(join(skill, "scripts/upload_files.py")));
    await expect(
      stat(join(variables.SKILL_DIR, "tests")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    const intake = await commands("import.md");
    expect(intake).toHaveLength(6);
    const helper = intake[0]!.split("post /batches ")[0]!;
    const request = (name: string, value: unknown) =>
      writeFile(
        join(WORK_DIR, name + ".json"),
        JSON.stringify({ protocol_version: 1, request: value }),
        { mode: 0o600 },
      );
    await writeFile(join(FILES_DIR, "files/a.pdf"), workbenchPdf());
    const bibliography =
      "@article{a,title={Synthetic literature workbench},doi={10.5555/sciretriever.fixture},file={PDF:files/a.pdf:application/pdf}}\n" +
      "@article{b,title={Synthetic missing attachment},file={PDF:files/missing.pdf:application/pdf}}\n" +
      "@article{c,title={Synthetic metadata only record}}";
    await request("empty", {});
    await request("data-0", { sequence: 0, data: bibliography });
    let lastBatch = "";
    for (const metadataOnly of [false, true]) {
      await request("create", {
        source: null,
        format: "bibtex",
        scope: "three synthetic records",
        file_name: "synthetic.bib",
        metadata_only: metadataOnly,
      });
      await shell(intake[0]!);
      const created = JSON.parse(
        await readFile(join(WORK_DIR, "created.json"), "utf8"),
      ).result.batch;
      lastBatch = created.batch_id;
      const setup = helper + `\nBID='${lastBatch}'\n`;
      await shell(setup + intake[1]!);
      await shell(setup + intake[3]!);
      await vi.waitFor(
        async () =>
          expect(
            (await app.importSessions.status(lastBatch)).progress?.phase,
          ).not.toBe("metadata"),
        { timeout: 20_000 },
      );
      if (!metadataOnly) {
        const output = await shell(setup + intake[4]!, 1);
        expect(output).toContain("本次成功 1 个");
        expect(output).toContain("file-not-found");
      }
      const output = await shell(setup + intake[5]!);
      expect(output).toContain('"state":"finished"');
      const report = await app.importSessions.report(lastBatch);
      expect(report.batch.result).toBe(metadataOnly ? "completed" : "partial");
      expect(report.summary.files.uploaded).toBe(metadataOnly ? 0 : 1);
      expect(report.summary.files.missing).toBe(metadataOnly ? 0 : 1);
      if (metadataOnly) {
        expect(report.summary.excluded).toEqual(
          expect.arrayContaining([
            { kind: "metadata-only-attachment", count: 2 },
          ]),
        );
        expect(
          (await app.importSessions.missingFiles(lastBatch)).items,
        ).toEqual([]);
      }
    }
    // Only PDFs: the packaged program sends them, waits for recognition and stops.
    const pdfs = await shell(intake[2]!);
    expect(pdfs).toContain("本次交了 1 个文件");
    expect(pdfs).toContain("?view=disc");
    expect(pdfs.includes(FILES_DIR)).toBe(false);
    const transport = new StreamableHTTPClientTransport(
      new URL("/mcp", server.origin),
      { requestInit: { headers: { Authorization: `Bearer ${secret}` } } },
    );
    client.onerror = () => {};
    await client.connect(new SdkTransportAdapter(transport));
    const listed = await client.listTools();
    expect(
      listed.tools.some((tool) => tool.name === "intake_batch_report"),
    ).toBe(true);
    const report = await client.callTool({
      name: "intake_batch_report",
      arguments: { batch_id: lastBatch },
    });
    expect(report.isError).not.toBe(true);
    expect(
      (
        await client.callTool({
          name: "search_library",
          arguments: { text: null, limit: 20, cursor: null },
        })
      ).isError,
    ).not.toBe(true);
    console.info(
      "Skill: 7 Bash blocks executed; 3 records, 1 PDF uploaded, 1 missing reported; metadata_only excluded 2 attachments; guide/ZIP downloads and official MCP read client passed. Credentials omitted.",
    );
  } finally {
    await client.close();
    await server.close();
    await session.close();
    await query.close();
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
}, 60_000);
