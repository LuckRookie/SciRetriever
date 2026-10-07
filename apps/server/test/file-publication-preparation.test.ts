import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createApplication } from "../src/bootstrap/application.js";
import { FileStore } from "../src/storage/files/store.js";
import { FIXTURE_LITERATURE } from "../src/workbench/synthetic-fixture.js";

it("allows a real catalog write while a file preparation is waiting on its copy", async () => {
  const home = await mkdtemp(
    join(tmpdir(), "sciretriever-file-preparation-admission-"),
  );
  const app = await createApplication(home);
  let release!: () => void;
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const stage = await app.files.stage();
    await stage.write(Buffer.alloc(3 * 1024 * 1024, 0x37));
    let first = true;
    const preparing = app.files.preparePublication(
      stage,
      "objects/prepared.bin",
      {
        write: async (handle, bytes, offset) => {
          if (first) {
            first = false;
            enter();
            await hold;
          }
          return handle.write(bytes, offset);
        },
      },
    );
    await entered;
    await app.database.putLiterature(FIXTURE_LITERATURE);
    expect(
      (await app.database.getLiterature(FIXTURE_LITERATURE.literature_id))
        ?.metadata.title,
    ).toBe(FIXTURE_LITERATURE.metadata.title);
    release();
    const prepared = await preparing;
    try {
      expect(
        await app.writes.run(() => app.files.commitPrepared(prepared)),
      ).toMatchObject({ created: true, size: 3 * 1024 * 1024 });
    } finally {
      await app.files.releasePrepared(prepared);
    }
  } finally {
    release();
    await app.close();
    await rm(home, { recursive: true, force: true });
  }
});

it.each(["source", "private-copy"] as const)(
  "refuses a changed %s after preparation without creating the target",
  async (change) => {
    const root = await mkdtemp(
      join(tmpdir(), "sciretriever-prepared-file-change-"),
    );
    const files = new FileStore(root);
    try {
      const stage = await files.stage();
      await stage.write(Buffer.from("original prepared bytes"));
      const source = stage.reference;
      const prepared = await files.preparePublication(
        stage,
        "objects/result.bin",
      );
      try {
        if (change === "source")
          await writeFile(join(root, source), "replacement bytes");
        else {
          const temporary = (await readdir(join(root, "objects"))).find(
            (name) => name.startsWith(".sciretriever-publication-"),
          )!;
          await writeFile(
            join(root, "objects", temporary),
            "replacement bytes",
          );
        }
        await expect(files.commitPrepared(prepared)).rejects.toThrow();
        expect(await readdir(join(root, "objects"))).not.toContain(
          "result.bin",
        );
      } finally {
        await files.releasePrepared(prepared);
      }
    } finally {
      await files.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("keeps create-if-absent semantics for a destination created after preparation", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "sciretriever-prepared-target-race-"),
  );
  const files = new FileStore(root);
  try {
    const stage = await files.stage();
    await stage.write(Buffer.from("incoming"));
    const prepared = await files.preparePublication(
      stage,
      "objects/result.bin",
    );
    try {
      await writeFile(join(root, "objects", "result.bin"), "existing");
      await expect(files.commitPrepared(prepared)).rejects.toThrow(
        "destination changed",
      );
      await prepared.refreshDestination();
      await expect(files.commitPrepared(prepared)).rejects.toMatchObject({
        conflict: true,
      });
      expect(await readdir(join(root, ".conflicts"))).toHaveLength(1);
    } finally {
      await files.releasePrepared(prepared);
    }
  } finally {
    await files.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects a replaced parent directory after preparation without publishing outside the held directory", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "sciretriever-prepared-parent-change-"),
  );
  const files = new FileStore(root);
  try {
    const stage = await files.stage();
    await stage.write(Buffer.from("incoming"));
    const prepared = await files.preparePublication(
      stage,
      "objects/result.bin",
    );
    try {
      const { rename } = await import("node:fs/promises");
      await rename(join(root, "objects"), join(root, "old-objects"));
      await mkdir(join(root, "objects"));
      await expect(files.commitPrepared(prepared)).rejects.toThrow();
      expect(await readdir(join(root, "objects"))).toEqual([]);
      expect(await readdir(join(root, "old-objects"))).not.toContain(
        "result.bin",
      );
    } finally {
      await files.releasePrepared(prepared);
    }
  } finally {
    await files.close();
    await rm(root, { recursive: true, force: true });
  }
});
