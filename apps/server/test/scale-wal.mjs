import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { setTimeout as wait } from "node:timers/promises";

const WAL_IDLE_LIMIT_MS = 30_000;

async function optionalStat(file, options) {
  return stat(file, options).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

export async function walReadLocks(catalog) {
  if (process.platform !== "linux") return null;
  const shm = await optionalStat(catalog + "-shm", { bigint: true });
  if (!shm) return [];
  const locks = await readFile("/proc/locks", "utf8").catch((error) => {
    if (["ENOENT", "EACCES", "EPERM"].includes(error.code)) return null;
    throw error;
  });
  if (locks === null) return null;
  const major =
    ((shm.dev & 0xfff00n) >> 8n) | ((shm.dev & 0xfffff00000000000n) >> 32n);
  const minor = (shm.dev & 0xffn) | ((shm.dev & 0xffffff00000n) >> 12n);
  const owners = [];
  for (const line of locks.split("\n")) {
    const match =
      /^\d+:\s+POSIX\s+ADVISORY\s+READ\s+(\d+)\s+([\da-f]+):([\da-f]+):(\d+)\s+(\d+)\s+(\d+|EOF)$/iu.exec(
        line.trim(),
      );
    if (!match) continue;
    const [, pid, deviceMajor, deviceMinor, inode, from, through] = match;
    if (
      BigInt(`0x${deviceMajor}`) !== major ||
      BigInt(`0x${deviceMinor}`) !== minor ||
      BigInt(inode) !== shm.ino
    )
      continue;
    // SQLite's unix VFS WAL read marks occupy shm bytes 123 through 127.
    // Byte 128 is the shared-memory lifetime lock, held by idle connections too.
    const first = Math.max(123, Number(from));
    const last = Math.min(127, through === "EOF" ? Infinity : Number(through));
    if (first <= last)
      owners.push({ pid: Number(pid), from: first, through: last });
  }
  return owners;
}

export function traceWalChecks(Worker, catalog, report, reportRequest) {
  const idle = Worker.prototype.idleWalCheckpoint;
  Worker.prototype.idleWalCheckpoint = async function () {
    if (this.path !== catalog) return idle.call(this);
    const requested_at_ms = Date.now();
    const request = {
      pid: process.pid,
      requested_at_ms,
      readers_before: await walReadLocks(catalog),
    };
    reportRequest?.(request);
    const record = async (result) =>
      report({
        ...request,
        finished_at_ms: Date.now(),
        ...result,
        readers_after: await walReadLocks(catalog),
      });
    let result;
    try {
      result = await idle.call(this);
    } catch (error) {
      await record({ error: String(error) });
      throw error;
    }
    await record(result);
    return result;
  };
  return () => {
    Worker.prototype.idleWalCheckpoint = idle;
  };
}

export async function watchIdleWal(
  catalog,
  samples,
  signal,
  began = Date.now(),
) {
  const deadline = performance.now() + 60_000;
  let idleSince = began;
  for (;;) {
    signal?.throwIfAborted();
    const wal = await optionalStat(catalog + "-wal");
    const now = Date.now();
    if (wal?.size) idleSince = Math.max(idleSince, wal.mtimeMs);
    const idle_ms = now - idleSince;
    samples.push({
      at_ms: now,
      elapsed_ms: now - began,
      size: wal?.size ?? 0,
      mtime_ms: wal?.mtimeMs ?? null,
      idle_since_ms: idleSince,
      idle_ms,
    });
    if (!wal) return;
    const timeToShrink = wal.size ? null : wal.mtimeMs - idleSince;
    if (timeToShrink !== null && timeToShrink <= WAL_IDLE_LIMIT_MS) return;
    const idleExpired = (timeToShrink ?? idle_ms) >= WAL_IDLE_LIMIT_MS;
    if (idleExpired || performance.now() >= deadline) {
      const readers = await walReadLocks(catalog);
      assert.fail(
        `${idleExpired ? "WAL did not shrink within 30 s of idleness" : "WAL did not settle within 60 s of observation"} (${wal.size} bytes, ${Math.round(timeToShrink ?? idle_ms)} ms idle, readers ${JSON.stringify(readers)})`,
      );
    }
    await wait(200, undefined, { signal });
  }
}
