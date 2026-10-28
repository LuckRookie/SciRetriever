import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { basename, dirname } from "node:path";
import {
  idleIndexRefreshStatus,
  parseIndexRefreshStatus,
  parseStrictJsonObject,
  type IndexRefreshStatus,
} from "@sciretriever/contracts";
import { CatalogWriteAdmission } from "./write-admission.js";

/** Small, non-secret, rebuildable projection queue beside the catalog, not an asset. */
export class IndexRefreshStateStore {
  private readonly admission: CatalogWriteAdmission;
  readonly path: string;
  constructor(catalog: string) {
    this.path = `${catalog}.index-refresh.json`;
    // The lock identity is stable even when atomic rename replaces the state file.
    this.admission = new CatalogWriteAdmission(
      `${catalog}.index-refresh-state`,
    );
  }
  static async read(
    path: string,
    repairJson = false,
  ): Promise<IndexRefreshStatus> {
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.size > 65536 ||
        (stat.mode & 0o777) !== 0o600 ||
        stat.uid !== process.getuid?.()
      )
        throw new Error("index-refresh-state-invalid");
      const bytes = await file.readFile();
      try {
        return parseIndexRefreshStatus(parseStrictJsonObject(bytes));
      } catch (error) {
        if (repairJson) return idleIndexRefreshStatus();
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return idleIndexRefreshStatus();
      throw error;
    } finally {
      await file?.close();
    }
  }
  read() {
    return IndexRefreshStateStore.read(this.path);
  }
  static async status(path: string): Promise<IndexRefreshStatus> {
    try {
      return await IndexRefreshStateStore.read(path);
    } catch {
      return {
        ...idleIndexRefreshStatus(),
        status: "failed",
        technical_details: { code: "index-refresh-state-invalid" },
      };
    }
  }
  update(
    change: (state: IndexRefreshStatus) => IndexRefreshStatus,
    repairJson = false,
  ) {
    return this.admission.run(async () => {
      const state = parseIndexRefreshStatus(
        change(await IndexRefreshStateStore.read(this.path, repairJson)),
      );
      const directory = await open(
        dirname(this.path),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const temporary = `/proc/self/fd/${directory.fd}/.${basename(this.path)}-${randomUUID()}`;
      try {
        const file = await open(
          temporary,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await file.writeFile(JSON.stringify(state));
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(
          temporary,
          `/proc/self/fd/${directory.fd}/${basename(this.path)}`,
        );
        await directory.sync();
        return state;
      } finally {
        await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
        await directory.close();
      }
    });
  }
  close() {
    return this.admission.close();
  }
}
