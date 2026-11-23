import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createApplication } from "../dist/bootstrap/application.js";
import { runWithCliSignals } from "../dist/cli/main.js";

const [home, jobId] = process.argv.slice(2);
const application = await createApplication(home, {
  indexRefreshIntervalMs: null,
  browserHost: () => null,
  metadataAssembly: {
    transportFactory: () => ({
      async request(url, options) {
        const anchor = new URL(url).searchParams.get("filter");
        if (anchor === "cites:W101")
          return {
            meta: {},
            results: [
              {
                id: "https://openalex.org/W102",
                doi: "https://doi.org/10.5555/citation-abort-102",
                title: "Offline citation work 102",
                publication_year: 2026,
                cited_by_count: 1,
              },
            ],
          };
        assert.equal(anchor, "cites:W102");
        process.send("second-layer");
        try {
          await delay(60_000, undefined, { signal: options?.signal });
          throw new Error("Fixture provider was not cancelled");
        } finally {
          if (options?.signal?.aborted) {
            // Model a transport that needs to drain before returning the abort.
            const finished = new Promise((resolve) =>
              process.once("message", resolve),
            );
            process.send("draining");
            assert.equal(await finished, "finish-drain");
          }
        }
      },
    }),
  },
});

await runWithCliSignals(async (signal) => {
  try {
    await application.processingTasks.runResults(jobId, signal);
    signal.throwIfAborted();
  } catch (error) {
    if (error !== signal.reason || !signal.aborted) throw error;
    process.exitCode = 130;
  } finally {
    await application.close();
  }
});
process.disconnect();
