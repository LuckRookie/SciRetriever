import { describe, expect, it, vi } from "vitest";
import { ExecutionRuntimeOwner } from "../src/storage/execution/runtime-owner.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("execution runtime ownership", () => {
  it("shares ownership across nested and concurrent operations until the final operation exits", async () => {
    const held = deferred();
    const entered = deferred();
    const release = vi.fn(async () => {});
    const acquire = vi.fn(async () => ({ release }));
    const owner = new ExecutionRuntimeOwner(acquire);
    const first = owner.run(async () => {
      entered.resolve();
      await held.promise;
    });
    try {
      await entered.promise;
      await owner.run(() => owner.run(async () => "nested"));
      expect(acquire).toHaveBeenCalledTimes(1);
      expect(release).not.toHaveBeenCalled();
    } finally {
      held.resolve();
      await first;
    }
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("waits for an asynchronous release before the next acquisition", async () => {
    const releasing = deferred();
    const releaseGate = deferred();
    const acquire = vi.fn(async () => ({
      release: async () => {
        releasing.resolve();
        await releaseGate.promise;
      },
    }));
    const owner = new ExecutionRuntimeOwner(acquire);
    const nextOperation = vi.fn(async () => "next");
    const first = owner.run(async () => "first");
    await releasing.promise;
    const next = owner.run(nextOperation);
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(acquire).toHaveBeenCalledTimes(1);
      expect(nextOperation).not.toHaveBeenCalled();
    } finally {
      releaseGate.resolve();
      await Promise.all([first, next]);
    }
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(nextOperation).toHaveBeenCalledOnce();
  });

  it("can retry admission after a refused acquisition and releases after an operation fails", async () => {
    const release = vi.fn(async () => {});
    const acquire = vi
      .fn(async () => ({ release }))
      .mockRejectedValueOnce(new Error("synthetic lock conflict"));
    const owner = new ExecutionRuntimeOwner(acquire);
    const operation = vi.fn(async () => {
      throw new Error("synthetic failure");
    });
    await expect(owner.run(operation)).rejects.toThrow(
      "synthetic lock conflict",
    );
    expect(operation).not.toHaveBeenCalled();
    await expect(owner.run(operation)).rejects.toThrow("synthetic failure");
    expect(release).toHaveBeenCalledOnce();
    await expect(owner.run(async () => "recovered")).resolves.toBe("recovered");
    expect(release).toHaveBeenCalledTimes(2);
  });
});
