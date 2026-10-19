import { readingAssets } from "./reading-assets-fixture.js";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { chromium } from "playwright";
import {
  parseLiterature,
  type ProcessorBatchRequest,
} from "@sciretriever/contracts";
import { coreProcessingFixture } from "../../server/test/core-processing-fixture.js";
import { createQueryApplication } from "../../server/src/bootstrap/application.js";
import {
  processorHttpAdapters,
  taskHttpAdapters,
} from "../../server/src/bootstrap/workbench.js";
import {
  startWorkbenchHttp,
  type WorkbenchStaticAsset,
} from "../../server/src/workbench/http.js";
import { ProductionWorkbenchSession } from "../../server/src/workbench/production-session.js";
import { FIXTURE_LITERATURE } from "../../server/src/workbench/synthetic-fixture.js";

export const missingId = "00000000-0000-0000-0000-000000005101";
export async function workspace(
  analysisModel = true,
  setup?: (
    env: Awaited<ReturnType<typeof coreProcessingFixture>>,
  ) => Promise<void>,
) {
  const env = await coreProcessingFixture({ analysisModel });
  const dispose: (() => Promise<void>)[] = [() => env.close()];
  const close = async () => {
    for (const action of dispose.reverse()) await action();
  };
  try {
    await env.app.database.putLiterature(
      parseLiterature({
        ...FIXTURE_LITERATURE,
        literature_id: missingId,
        meta_literature_id: "00000000-0000-0000-0000-000000005102",
        metadata: {
          ...FIXTURE_LITERATURE.metadata,
          title: "Unparsed source",
          identifiers: [],
        },
      }),
    );
    env.setText(
      "# Measurements\nThe measured energy was 4.2 eV.\n\n## Context\nA separate discussion.\n",
    );
    if (setup) await setup(env);
    const parsed = await env.app.documentProcessing.parseDocuments(
      env.parseRequest,
    );
    env.setModel((input) => ({
      answer: true,
      source_ids: [input.segments![0]!.segment_id],
      reason: null,
    }));
    const query = await createQueryApplication(env.home);
    dispose.push(() => query.close());
    const session = new ProductionWorkbenchSession(null, async () => {
      throw new Error("unexpected browser action");
    });
    dispose.push(() => session.close());
    const assets = new Map<string, WorkbenchStaticAsset>(await readingAssets());
    for (const [route, file, contentType] of [
      ["/", "live.html", "text/html"],
      ["/styles.css", "styles.css", "text/css"],
      ["/live.css", "live.css", "text/css"],
      ["/workspace.css", "workspace.css", "text/css"],
    ] as const)
      assets.set(route, {
        contentType,
        body: await readFile(new URL(`../public/${file}`, import.meta.url)),
      });
    const bundle = await build({
      entryPoints: [new URL("../src/live.ts", import.meta.url).pathname],
      bundle: true,
      format: "esm",
      platform: "browser",
      write: false,
    });
    assets.set("/live.js", {
      contentType: "text/javascript",
      body: bundle.outputFiles[0]!.contents,
    });
    const server = await startWorkbenchHttp({
      ...taskHttpAdapters(env.app),
      session,
      maintenance: env.app.maintenance!,
      query: {
        application: query,
        maintenance: env.app.maintenance!,
        ...processorHttpAdapters(env.app),
      },
      library: {
        queries: env.app.library,
        artifacts: env.app.literatureArtifacts,
      },
      assets,
    });
    dispose.push(() => server.close());
    const browser = await chromium.launch({
      ...(process.env.SCIRETRIEVER_BROWSER_EXECUTABLE
        ? { executablePath: process.env.SCIRETRIEVER_BROWSER_EXECUTABLE }
        : {}),
      headless: true,
    });
    dispose.push(() => browser.close());
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    page.setDefaultTimeout(5000);
    const errors: string[] = [],
      submissions: ProcessorBatchRequest[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (
        new URL(request.url()).pathname ===
        "/api/v1/maintenance/processor-submit"
      )
        submissions.push(
          (request.postDataJSON() as { request: ProcessorBatchRequest })
            .request,
        );
    });
    await page.goto(server.origin);
    await page
      .locator(`[data-ck="${env.parseRequest.literature_id}"]`)
      .waitFor();
    return { env, page, parsed, submissions, errors, close };
  } catch (error) {
    await close();
    throw error;
  }
}
