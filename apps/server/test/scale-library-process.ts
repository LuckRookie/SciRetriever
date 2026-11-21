// Run as a local Node child after pnpm build. All product entry points come from dist.
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { runCli } from "../dist/cli/main.js";
import { startProductionWorkbench } from "../dist/bootstrap/workbench.js";
import { CatalogWriteAdmission } from "../dist/storage/write-admission.js";
import { SqliteWorker } from "../dist/storage/sqlite/worker.js";
import { EMPTY_METADATA, parseLiterature } from "@sciretriever/contracts";

const [kind, home, ...args] = process.argv.slice(2);
if (!home) throw new Error("An explicit synthetic home is required");

if (kind === "cli") {
  let diagnostic = "";
  const result = await runCli(args, {
    home,
    json: true,
    stdout: () => {},
    stderr: (text) => {
      diagnostic += text;
    },
  });
  if (args[0] === "jobs" && result.code === 0) {
    const detail = result.value as {
      job: { status: string };
      source_results: unknown;
    };
    process.stdout.write(
      JSON.stringify({
        code: result.code,
        status: detail.job.status,
        source_results: detail.source_results,
      }),
    );
  } else {
    process.stdout.write(
      JSON.stringify({ ...result, diagnostic: diagnostic.trim() }),
    );
  }
  process.exitCode = result.code;
} else if (kind === "serve") {
  const server = await startProductionWorkbench({
    home,
    port: 0,
    access: { host: "127.0.0.1", password: "synthetic-scale-library-local" },
    applicationOptions: {
      metadata: {},
      browserHost: () => null,
    },
  });
  process.send?.({ origin: server.origin });
  try {
    await once(process, "SIGTERM");
  } finally {
    await server.close();
    process.disconnect?.();
  }
} else if (kind === "writer") {
  const catalog = args[0];
  if (!catalog) throw new Error("An explicit synthetic catalog is required");
  const admission = new CatalogWriteAdmission(catalog);
  const worker = new SqliteWorker(catalog, admission);
  let stop = false;
  process.once("SIGTERM", () => {
    stop = true;
  });
  try {
    for (let n = 1; !stop; n++) {
      const row = n.toString(16).padStart(12, "0");
      await worker.putLiterature(
        parseLiterature({
          literature_id: `e05ca1e0-0001-4000-8000-${row}`,
          meta_literature_id: `e05ca1e0-0002-4000-8000-${row}`,
          version_role: "published",
          status: "UNREVIEWED",
          metadata: {
            ...EMPTY_METADATA,
            title: `Synthetic field measurements in the concurrent write stream ${n}`,
            abstract:
              "Generated offline for a steady background-write benchmark.",
            publication_form: "journal-article",
            publication_year: 2026,
          },
        }),
      );
      if (n === 1) process.send?.({ ready: true });
      await delay(250);
    }
  } finally {
    await worker.close();
    await admission.close();
    process.disconnect?.();
  }
} else {
  throw new Error("Unknown scale library process");
}
