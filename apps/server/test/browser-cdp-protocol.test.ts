import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { OwnedBrowserCdpConnection } from "../src/browser/cdp.js";

class Socket extends EventTarget {
  static readonly instances: Socket[] = [];
  readonly sent: { id: number; method: string; sessionId?: string }[] = [];
  constructor() {
    super();
    Socket.instances.push(this);
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as (typeof this.sent)[number]);
  }
  reply(value: Record<string, unknown>): void {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(value) }),
    );
  }
  close(): void {
    this.dispatchEvent(new Event("close"));
  }
}

const directories: string[] = [];
const connections: OwnedBrowserCdpConnection[] = [];
afterEach(async () => {
  for (const connection of connections.splice(0)) connection.close();
  Socket.instances.splice(0);
  vi.unstubAllGlobals();
  vi.useRealTimers();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const profile = await mkdtemp(join(tmpdir(), "sciretriever-cdp-protocol-"));
  directories.push(profile);
  await writeFile(
    join(profile, "DevToolsActivePort"),
    "9999\n/devtools/browser/00000000-0000-0000-0000-000000000000\n",
  );
  vi.stubGlobal("WebSocket", Socket);
  const connection = await OwnedBrowserCdpConnection.connect(profile);
  connections.push(connection);
  return { connection, socket: Socket.instances.at(-1)! };
}

it("cancels only one owned command wait and ignores its late reply without losing another session", async () => {
  const { connection, socket } = await fixture();
  const disconnected = vi.fn();
  connection.onDisconnect(disconnected);
  const controller = new AbortController();
  const reading = connection.send(
    "IO.read",
    { handle: "stopped-stream", size: 65536 },
    "session-a",
    120000,
    controller.signal,
  );
  const other = connection.send("Page.getFrameTree", {}, "session-b");
  const cancelled = expect(reading).rejects.toMatchObject({
    code: "browser-protocol",
    reason: "command-cancelled",
  });
  controller.abort();
  await cancelled;
  expect(
    (Reflect.get(connection, "pending") as Map<unknown, unknown>).size,
  ).toBe(1);
  socket.reply({ id: socket.sent[0]!.id, result: { data: "", eof: true } });
  expect(
    (Reflect.get(connection, "pending") as Map<unknown, unknown>).size,
  ).toBe(1);
  socket.reply({
    id: socket.sent[1]!.id,
    result: { frameTree: "other-owner" },
  });
  await expect(other).resolves.toEqual({ frameTree: "other-owner" });
  expect(
    (Reflect.get(connection, "pending") as Map<unknown, unknown>).size,
  ).toBe(0);
  expect(disconnected).not.toHaveBeenCalled();
});

it("does not dispatch a command whose wait was already cancelled", async () => {
  const { connection, socket } = await fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(
    connection.send("IO.read", {}, undefined, 120000, controller.signal),
  ).rejects.toMatchObject({ reason: "command-cancelled" });
  expect(socket.sent).toEqual([]);
  expect(
    (Reflect.get(connection, "pending") as Map<unknown, unknown>).size,
  ).toBe(0);
});

it("removes the command's abort listener after an ordinary reply", async () => {
  const { connection, socket } = await fixture();
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  const reading = connection.send(
    "IO.read",
    {},
    undefined,
    120000,
    controller.signal,
  );
  socket.reply({ id: socket.sent[0]!.id, result: { data: "tail", eof: true } });
  await expect(reading).resolves.toEqual({ data: "tail", eof: true });
  expect(remove).toHaveBeenCalledExactlyOnceWith("abort", expect.any(Function));
  controller.abort();
  expect(
    (Reflect.get(connection, "pending") as Map<unknown, unknown>).size,
  ).toBe(0);
});

it.each(["timeout-first", "cancel-first"] as const)(
  "removes the command timer and listener once when %s",
  async (order) => {
    const { connection, socket } = await fixture();
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const waiting = connection.send(
      "IO.read",
      {},
      undefined,
      10,
      controller.signal,
    );
    const rejected = expect(waiting).rejects.toMatchObject({
      reason: order === "timeout-first" ? "timeout" : "command-cancelled",
    });
    if (order === "timeout-first") {
      await vi.advanceTimersByTimeAsync(10);
      controller.abort();
    } else {
      controller.abort();
      await vi.advanceTimersByTimeAsync(10);
    }
    await rejected;
    expect(remove).toHaveBeenCalledExactlyOnceWith(
      "abort",
      expect.any(Function),
    );
    expect(vi.getTimerCount()).toBe(0);
    socket.reply({
      id: socket.sent[0]!.id,
      result: { data: "late", eof: true },
    });
    expect(
      (Reflect.get(connection, "pending") as Map<unknown, unknown>).size,
    ).toBe(0);
  },
);

it("removes a command listener when its owned connection closes", async () => {
  const { connection } = await fixture();
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, "removeEventListener");
  const waiting = connection.send(
    "IO.read",
    {},
    undefined,
    120000,
    controller.signal,
  );
  const closed = expect(waiting).rejects.toMatchObject({ reason: "closed" });
  connection.close();
  await closed;
  expect(remove).toHaveBeenCalledExactlyOnceWith("abort", expect.any(Function));
  controller.abort();
  expect(
    (Reflect.get(connection, "pending") as Map<unknown, unknown>).size,
  ).toBe(0);
});

it.each([
  [-32602, "Invalid InterceptionId.", "request-inactive"],
  [-32602, "Another protocol error.", "operation"],
  [-32000, "Invalid InterceptionId.", "operation"],
] as const)(
  "retains exact protocol failure classification (%s / %s)",
  async (code, message, reason) => {
    const { connection, socket } = await fixture();
    const operation = connection.send("Fetch.failRequest", {
      requestId: "synthetic-original",
    });
    socket.reply({ id: socket.sent[0]!.id, error: { code, message } });
    await expect(operation).rejects.toMatchObject({ reason });
  },
);
