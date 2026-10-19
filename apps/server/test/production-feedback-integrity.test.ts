import { workbenchTestAccess } from "./workbench-auth-fixture.js";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parseWorkbenchView } from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { startProductionWorkbench } from "../src/bootstrap/workbench.js";
import {
  FIXTURE_LITERATURE,
  workbenchPdf,
} from "../src/workbench/synthetic-fixture.js";

it("does not call a catalog primary PDF readable after its verified bytes are damaged or missing", async () => {
  const home = await mkdtemp(
    join(tmpdir(), "sciretriever-feedback-integrity-"),
  );
  let writer: Awaited<ReturnType<typeof createApplication>> | undefined;
  let workbench:
    | Awaited<ReturnType<typeof startProductionWorkbench>>
    | undefined;
  try {
    await mkdir(join(home, ".sciretriever"), { mode: 0o700 });
    await writeFile(
      join(home, ".sciretriever", "config.toml"),
      `[paths]\ncatalog_path=${JSON.stringify(join(home, "catalog.sqlite"))}\nartifact_root=${JSON.stringify(join(home, "artifacts"))}\n`,
      { mode: 0o600 },
    );
    writer = await createApplication(home, {
      executionSchema: "upgrade-synthetic",
      browserHost: () => null,
    });
    await writer.database.putLiterature(FIXTURE_LITERATURE);
    const receipt = await writer.maintenance!.ingestPdf({
      literature_id: FIXTURE_LITERATURE.literature_id,
      bytes: workbenchPdf(),
    });
    const asset = (
      await writer.library.detail(FIXTURE_LITERATURE.literature_id)
    ).primary_pdf!.asset;
    await writer.close();
    writer = undefined;
    const file = join(home, "artifacts", asset.path);
    workbench = await startProductionWorkbench({
      access: workbenchTestAccess,
      home,
      literature_id: FIXTURE_LITERATURE.literature_id,
      assets: new Map([["/", { contentType: "text/html", body: "ok" }]]),
      configurationProbeSeams: { browser_site_factory: async () => null },
      applicationOptions: { browserHost: () => null },
    });
    for (const damage of ["corrupt", "missing"] as const) {
      if (damage === "corrupt")
        await writeFile(file, Buffer.alloc(asset.size_bytes, 0x41));
      else await rm(file);
      workbench.session.start(FIXTURE_LITERATURE.literature_id);
      const view = parseWorkbenchView(
        await workbench.session.waitForCompletion(),
      );
      expect(view.state).toBe("failed");
      expect(view.operation_feedback?.primary_pdf).toBeNull();
      expect(view.operation_feedback?.primary_pdf_status).toBe("unreadable");
      expect(view.operation_feedback?.failure?.code).toBe(
        "library-read-unavailable",
      );
      expect(workbench.session.operationFailure()?.cause).toBeInstanceOf(Error);
      expect(JSON.stringify(view)).not.toContain(file);
      expect(
        (
          await workbench.application.library.detail(
            FIXTURE_LITERATURE.literature_id,
          )
        ).primary_pdf?.asset.sha256,
      ).toBe(receipt.sha256);
    }
  } finally {
    await workbench?.close();
    await writer?.close();
    await rm(home, { recursive: true, force: true });
  }
});
