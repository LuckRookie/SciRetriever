// Synthetic-only process fixture. The real IPC, supervisor, HTTP and task owners run unchanged.
import { readFile, writeFile, appendFile, access, rm } from "node:fs/promises";
import process from "node:process";
import { Buffer } from "node:buffer";
import { setInterval, clearInterval } from "node:timers";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { runWebWorker } from "../../dist/cli/web-worker-runtime.js";
import { startProductionWorkbench } from "../../dist/bootstrap/workbench.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../../dist/workbench/synthetic-fixture.js";
import { networkRequestDispatched } from "../../dist/network/request-activity.js";
import {
  canonicalJsonBytes,
  rawParseIdentity,
  parseRawParse,
  sha256,
} from "@sciretriever/contracts";
const exists = async (path) =>
  access(path).then(
    () => true,
    () => false,
  );
runWebWorker(async (options) => {
  const home = options.home;
  const scenario = await readFile(join(home, "scenario"), "utf8").catch(
    () => "",
  );
  if (scenario === "startup-failed")
    throw new Error("synthetic-startup-failure");
  const identity = async (profile) => ({
    parser_version: "synthetic-1",
    model_identity: `synthetic-${profile}`,
    parameters_sha256: await sha256(Buffer.from(profile)),
  });
  const rawParser = {
    identity,
    parseRaw: async (request, profile, signal) => {
      await appendFile(join(home, "parser-started"), "started\n");
      while (!(await exists(join(home, "finish-parsing")))) {
        if (signal?.aborted) throw new Error("synthetic-cancelled");
        await sleep(10);
      }
      const markdownBytes = Buffer.from(
        "# Synthetic lifecycle article\n\nA durable paragraph.\n",
      );
      const blocksBytes = canonicalJsonBytes({
        schema_version: 1,
        page_count: 1,
        blocks: [
          {
            page: 0,
            index: 0,
            type: "text",
            title_level: null,
            text: "A durable paragraph.",
            html: null,
            image_ref: null,
            bbox: [0, 0, 1000, 1000],
            source_type: "synthetic",
          },
        ],
      });
      const artifact = async (bytes, media_type) => ({
        sha256: await sha256(bytes),
        byte_size: bytes.length,
        media_type,
      });
      const blocks = {
          bytes: blocksBytes,
          artifact: await artifact(blocksBytes, "application/json"),
        },
        privateBytes = Buffer.from("[]"),
        private_content_list = {
          bytes: privateBytes,
          artifact: await artifact(privateBytes, "application/json"),
        },
        markdown = {
          bytes: markdownBytes,
          artifact: await artifact(markdownBytes, "text/markdown"),
        };
      const input = {
        source_asset_id: request.source_asset_id,
        source_sha256: request.source_sha256,
        profile,
        ...(await identity(profile)),
        page_count: 1,
        page_sizes: [[595, 842]],
        blocks: blocks.artifact,
        private_content_list: private_content_list.artifact,
        markdown: markdown.artifact,
        resources: [],
      };
      return {
        result: await parseRawParse({
          ...input,
          ...(await rawParseIdentity(input)),
        }),
        blocks,
        private_content_list,
        markdown,
        resources: [],
      };
    },
  };
  const server = await startProductionWorkbench({
    ...options,
    configurationProbeSeams: {
      metadata_assembly: {
        transportFactory: (source) => ({
          request: async () => {
            if (source !== "crossref")
              throw new Error("synthetic-source-not-selected");
            networkRequestDispatched();
            await appendFile(join(home, "probe-started"), "started\n");
            while (!(await exists(join(home, "finish-probe")))) await sleep(10);
            return {
              status: "ok",
              "message-type": "work",
              message: {
                DOI: "10.1038/s41586-020-2649-2",
                title: ["Synthetic probe record"],
              },
            };
          },
        }),
      },
    },
    assets: new Map([
      [
        "/",
        {
          contentType: "text/html",
          body: "<main>Synthetic lifecycle fixture</main>",
        },
      ],
    ]),
    applicationOptions: {
      ...options.applicationOptions,
      parsing: { rawParser },
      browserHost: () => null,
    },
  });
  if (!(await exists(join(home, "seed.json")))) {
    await server.application.database.putLiterature(FIXTURE_LITERATURE);
    await server.application.maintenance.ingestPdf({
      literature_id: FIXTURE_LITERATURE.literature_id,
      bytes: workbenchPdf(),
    });
    const asset = (
      await server.application.library.detail(FIXTURE_LITERATURE.literature_id)
    ).primary_pdf.asset;
    await writeFile(
      join(home, "seed.json"),
      JSON.stringify({
        literature_id: FIXTURE_LITERATURE.literature_id,
        asset_id: asset.asset_id,
        asset_sha256: asset.sha256,
      }),
    );
  }
  const actualClose = server.close;
  let transferStarting,
    transferWork,
    transferStarted = false,
    closingFixture = false;
  const testTimer = setInterval(async () => {
    if (await exists(join(home, "exit75"))) process.exit(75);
    if (!transferStarted && (await exists(join(home, "begin-transfer")))) {
      transferStarted = true;
      await rm(join(home, "begin-transfer"));
      transferStarting = server.application.restartAdmission.newWork(
        async () => {
          const admitted = await server.application.restartAdmission.background(
            async () => {
              const collector = server.application.execution.transfers;
              await collector.begin("synthetic-lifecycle-transfer", 1048576);
              await collector.append(
                "synthetic-lifecycle-transfer",
                workbenchPdf(),
              );
              await writeFile(join(home, "transfer-started"), "");
              while (
                !closingFixture &&
                !(await exists(join(home, "cancel-transfer")))
              )
                await sleep(10);
              await collector.discard("synthetic-lifecycle-transfer");
              await writeFile(join(home, "transfer-cancel-observed"), "");
              while (
                !closingFixture &&
                !(await exists(join(home, "finish-transfer-cleanup")))
              )
                await sleep(10);
            },
            "browser_transfers",
          );
          transferWork = admitted.promise;
        },
      );
      void transferStarting.catch(() => undefined);
    }
  }, 20);
  testTimer.unref();
  return {
    ...server,
    close: async () => {
      closingFixture = true;
      clearInterval(testTimer);
      await transferStarting;
      await transferWork;
      while (
        (await exists(join(home, "stall-close"))) &&
        !(await exists(join(home, "allow-close")))
      )
        await sleep(10);
      await actualClose();
    },
  };
});
