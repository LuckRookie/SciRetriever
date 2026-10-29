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

/** Queue intent stays private; operation/progress describe the actual attempt. */
export interface IndexRefreshState extends IndexRefreshStatus {
  readonly rebuild_requested?: number;
  readonly rebuild_settled?: number;
}
function parseState(value: unknown): IndexRefreshState {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("index-refresh-state-invalid");
  const { rebuild_requested, rebuild_settled, ...publicState } =
    value as Record<string, unknown>;
  const state = parseIndexRefreshStatus(publicState);
  for (const n of [rebuild_requested, rebuild_settled])
    if (
      n !== undefined &&
      (!Number.isSafeInteger(n) ||
        Number(n) < 0 ||
        Number(n) > state.request_sequence)
    )
      throw new Error("index-refresh-state-invalid");
  if (Number(rebuild_settled ?? 0) > Number(rebuild_requested ?? 0))
    throw new Error("index-refresh-state-invalid");
  return {
    ...state,
    ...(rebuild_requested === undefined
      ? {}
      : { rebuild_requested: Number(rebuild_requested) }),
    ...(rebuild_settled === undefined
      ? {}
      : { rebuild_settled: Number(rebuild_settled) }),
  };
}
function publicStatus(state: IndexRefreshState): IndexRefreshStatus {
  const {
    rebuild_requested: _requested,
    rebuild_settled: _settled,
    ...value
  } = state;
  void _requested;
  void _settled;
  return value;
}

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
  ): Promise<IndexRefreshState> {
    for (let attempt = 0; attempt < 8; attempt++) {
      let file: Awaited<ReturnType<typeof open>> | undefined;
      try {
        file = await open(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        const stat = await file.stat();
        // Atomic rename may retire this inode between open and fstat. Reopen
        // the current path; never accept zero links or weaken hardlink checks.
        if (stat.nlink === 0) continue;
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
          return parseState(parseStrictJsonObject(bytes));
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
    throw new Error("index-refresh-state-invalid");
  }
  read() {
    return IndexRefreshStateStore.read(this.path);
  }
  static async status(path: string): Promise<IndexRefreshStatus> {
    try {
      return publicStatus(await IndexRefreshStateStore.read(path));
    } catch {
      return {
        ...idleIndexRefreshStatus(),
        status: "failed",
        technical_details: { code: "index-refresh-state-invalid" },
      };
    }
  }
  update(
    change: (state: IndexRefreshState) => IndexRefreshState,
    repairJson = false,
  ) {
    return this.admission.run(async () => {
      const state = parseState(
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
