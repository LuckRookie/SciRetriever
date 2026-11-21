// Run as a local Node child after pnpm build. All product entry points come from dist.
import { createHash } from "node:crypto";
import { once } from "node:events";
import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { runCli } from "../dist/cli/main.js";
import { startProductionWorkbench } from "../dist/bootstrap/workbench.js";
import {
  fallbackIdentityKey,
  fallbackIdentitySha256,
} from "../dist/literature/identity-rules.js";
import { ftsIndexText } from "../dist/literature/unicode-casefold.js";
import { CatalogWriteAdmission } from "../dist/storage/write-admission.js";
import {
  canonicalJsonBytes,
  EMPTY_METADATA,
  parseLiterature,
} from "@sciretriever/contracts";

const [kind, home, ...args] = process.argv.slice(2);
if (!home) throw new Error("An explicit synthetic home is required");

if (kind === "cli") {
  const stop = new AbortController();
  const cancel = () => stop.abort(new Error("Scale CLI interrupted"));
  process.once("SIGTERM", cancel);
  let diagnostic = "";
  const result = await runCli(args, {
    home,
    json: true,
    signal: stop.signal,
    stdout: () => {},
    stderr: (text) => {
      diagnostic += text;
    },
  }).finally(() => {
    process.removeListener("SIGTERM", cancel);
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
  if (
    !catalog ||
    basename(catalog) !== "catalog.sqlite" ||
    dirname(dirname(catalog)) !== resolve("sandbox/runs") ||
    !basename(dirname(catalog)).startsWith(
      "2026-11-21-scale-library-writes-",
    ) ||
    home !== join(dirname(catalog), "home") ||
    (await realpath(catalog)) !== catalog
  )
    throw new Error("An isolated benchmark catalog copy is required");
  const firstWrite = Number(args[1] ?? 1);
  if (!Number.isSafeInteger(firstWrite) || firstWrite < 1)
    throw new Error("Invalid first synthetic write number");
  const admission = new CatalogWriteAdmission(catalog, { waitMs: 10_000 });
  const db = new DatabaseSync(catalog);
  let stop = false;
  process.once("SIGTERM", () => {
    stop = true;
  });
  try {
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
    const meta = db.prepare("INSERT INTO meta_literatures VALUES(?,?)");
    const literature = db.prepare("INSERT INTO literatures VALUES(?,?,?)");
    const metadata = db.prepare(
      "INSERT INTO literature_metadata(literature_id,metadata_revision,metadata_sha256,title,abstract,publication_year,publication_form) VALUES(?,1,?,?,?,?,?)",
    );
    const fallback = db.prepare(
      "INSERT INTO literature_fallback_identity_indexes VALUES(?,?)",
    );
    const fts = db.prepare(
      "INSERT INTO literature_search_fts(literature_id,title,abstract,authors,affiliations,identifiers,keywords,venue,publisher,volume,issue,pages,content_body) VALUES(?,?,?,'','','','','','','','','','')",
    );
    for (let n = firstWrite; !stop; n++) {
      const row = n.toString(16).padStart(12, "0");
      const entry = parseLiterature({
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
      });
      const digest = createHash("sha256")
        .update(canonicalJsonBytes(entry.metadata))
        .digest("hex");
      const key = fallbackIdentityKey(entry.metadata);
      const fallbackDigest =
        key === null ? null : await fallbackIdentitySha256(key);
      // Every ID is new. Use the fixture's insert-only approach to sustain the
      // requested write load, with the existing FK and revision triggers active.
      await admission.run(async () => {
        const id = entry.literature_id;
        const m = entry.metadata;
        db.exec("BEGIN IMMEDIATE");
        try {
          meta.run(entry.meta_literature_id, id);
          literature.run(id, entry.meta_literature_id, entry.version_role);
          metadata.run(
            id,
            digest,
            m.title,
            m.abstract,
            m.publication_year,
            m.publication_form,
          );
          if (fallbackDigest !== null) fallback.run(id, fallbackDigest);
          fts.run(
            id,
            ftsIndexText(m.title ?? ""),
            ftsIndexText(m.abstract ?? ""),
          );
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      });
      if (n === firstWrite) process.send?.({ ready: true });
      await delay(200);
    }
  } finally {
    db.close();
    await admission.close();
    process.disconnect?.();
  }
} else {
  throw new Error("Unknown scale library process");
}
