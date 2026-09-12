import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApplication } from "../src/bootstrap/application.js";

describe("application lifecycle", () => {
  it("creates one database and closes it idempotently from an offline home", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-application-"));
    const application = await createApplication(home);
    expect(application.home).toBe(home);
    expect(application.observations).toBeDefined();
    expect(application.files).toBeDefined();
    expect(application.agents.readiness("analysis")).toEqual({
      configured: false,
      missing: [],
    });
    const stage = await application.files.stage({ maxBytes: 16 });
    await stage.write(new TextEncoder().encode("temporary"));
    await expect(application.close()).resolves.toBeUndefined();
    await expect(application.close()).resolves.toBeUndefined();
    await expect(application.files.stage()).rejects.toMatchObject({
      code: "file-store",
    });
    await expect(application.database.schema()).rejects.toMatchObject({
      code: "sqlite-worker",
    });
  });

  it("cleans already-created resources when any later startup stage fails", async () => {
    const stages = [
      "database",
      "files",
      "network",
      "agents",
      "schema",
    ] as const;
    for (const failedStage of stages) {
      const home = await mkdtemp(
        join(tmpdir(), "sciretriever-startup-failure-"),
      );
      await expect(
        createApplication(home, {
          afterStage: (stage) => {
            if (stage === failedStage)
              throw new Error(`injected ${stage} failure`);
          },
        }),
      ).rejects.toThrow(`injected ${failedStage} failure`);
      let recovered;
      try {
        recovered = await createApplication(home);
      } catch (error) {
        throw new Error(
          `recovery after ${failedStage} failed: ${String(error)}`,
        );
      }
      await expect(recovered.database.schema()).resolves.toBeDefined();
      await expect(recovered.close()).resolves.toBeUndefined();
    }
  });

  it("reopens the same catalog after a normal close", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-reopen-"));
    const first = await createApplication(home);
    await first.close();
    const second = await createApplication(home);
    await second.close();
  });
});
