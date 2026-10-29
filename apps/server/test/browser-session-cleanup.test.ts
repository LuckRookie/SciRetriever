import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  BrowserHost,
  BrowserHostError,
  type BrowserPageHandle,
} from "../src/browser/host.js";
import { BrowserProtocolError } from "../src/browser/cdp.js";

function fixture(options: {
  readonly cancel?: () => Promise<void>;
  readonly pageClose?: () => Promise<void>;
  readonly drain: () => Promise<void>;
}) {
  const host = new BrowserHost({
    profile: join(tmpdir(), "sciretriever-unused-cleanup-fixture"),
  });
  const session = {
    id: "session-a",
    identity: null,
    controller: new AbortController(),
    pageIds: new Set(["a", "popup-a"]),
    networkAllowed: true,
    closing: false,
  };
  const close = vi.fn(options.pageClose ?? (async () => {}));
  const popupClose = vi.fn(async () => {});
  const otherClose = vi.fn(async () => {});
  const page = { isClosed: () => false, once: () => undefined, close };
  const sessions = new Map([[session.id, session]]);
  const stop = vi.fn(async () => {
    throw new BrowserProtocolError("target-inactive");
  });
  const cancel = vi.fn(options.cancel ?? (async () => {}));
  const drain = vi.fn(options.drain);
  const sessionClosed = vi.fn();
  Reflect.set(host, "sessions", sessions);
  Reflect.set(
    host,
    "pageSessions",
    new Map([
      ["a", session],
      ["popup-a", session],
    ]),
  );
  Reflect.set(
    host,
    "pages",
    new Map([
      ["a", page],
      [
        "popup-a",
        { isClosed: () => false, once: () => undefined, close: popupClose },
      ],
      [
        "b",
        { isClosed: () => false, once: () => undefined, close: otherClose },
      ],
    ]),
  );
  Reflect.set(host, "cdp", {
    stopSession: stop,
    drainSession: drain,
    sessionClosed,
  });
  Reflect.set(host, "transfers", { cancelSession: cancel });
  const handle = Reflect.get(host, "handle").call(
    host,
    "a",
    page,
  ) as BrowserPageHandle;
  return {
    handle,
    session,
    sessions,
    stop,
    cancel,
    drain,
    sessionClosed,
    close,
    popupClose,
    otherClose,
  };
}

it("retains session ownership until fallback closure receives a real network drain", async () => {
  let finishDrain!: () => void;
  const draining = new Promise<void>((resolve) => {
    finishDrain = resolve;
  });
  const f = fixture({ drain: () => draining });
  let settled = false;
  const closed = Promise.all([f.handle.close(), f.handle.close()]).then(() => {
    settled = true;
  });
  await vi.waitFor(() => expect(f.drain).toHaveBeenCalledOnce());
  expect(f.sessions.has(f.session.id)).toBe(true);
  expect(settled).toBe(false);
  expect(f.sessionClosed).not.toHaveBeenCalled();
  expect(f.session.controller.signal.aborted).toBe(true);
  expect(f.cancel).toHaveBeenCalledOnce();
  expect(f.close).toHaveBeenCalledOnce();
  expect(f.popupClose).toHaveBeenCalledOnce();
  expect(f.otherClose).not.toHaveBeenCalled();
  finishDrain();
  await closed;
  expect(f.sessions.has(f.session.id)).toBe(false);
  expect(f.stop).toHaveBeenCalledOnce();
  expect(f.sessionClosed).toHaveBeenCalledExactlyOnceWith(f.session.id);
});

it("attempts independent native and page cleanup and preserves an unconfirmed close on repeat", async () => {
  const writerFailure = new Error("native writer cancellation unconfirmed");
  const pageFailure = new Error("owned page close unconfirmed");
  const drainFailure = Object.assign(new Error("owned network still active"), {
    code: "browser-platform-handoff-stalled",
  });
  const f = fixture({
    cancel: async () => {
      throw writerFailure;
    },
    pageClose: async () => {
      throw pageFailure;
    },
    drain: async () => {
      throw drainFailure;
    },
  });
  const first = await f.handle.close().then(
    () => null,
    (error: BrowserHostError) => error,
  );
  expect(first).toBeInstanceOf(BrowserHostError);
  expect(first!.cause).toBeInstanceOf(AggregateError);
  expect((first!.cause as AggregateError).errors).toHaveLength(4);
  expect((first!.cause as AggregateError).errors).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ reason: "target-inactive" }),
      writerFailure,
      pageFailure,
      drainFailure,
    ]),
  );
  const second = await f.handle.close().then(
    () => null,
    (error: BrowserHostError) => error,
  );
  expect(second).toBeInstanceOf(BrowserHostError);
  expect(second!.cause).toBe(first!.cause);
  expect(f.sessions.has(f.session.id)).toBe(true);
  expect(f.sessionClosed).not.toHaveBeenCalled();
  expect(f.stop).toHaveBeenCalledOnce();
  expect(f.cancel).toHaveBeenCalledOnce();
  expect(f.close).toHaveBeenCalledOnce();
  expect(f.popupClose).toHaveBeenCalledOnce();
  expect(f.otherClose).not.toHaveBeenCalled();
  expect(f.drain).toHaveBeenCalledOnce();
});
