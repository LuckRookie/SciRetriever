import { once } from "node:events";
import { WebSocket } from "ws";
import { expect, it, vi } from "vitest";
import {
  SCREENCAST_PROTOCOL,
  decodeScreencastFrame,
  parseScreencastServerMessage,
  type ScreencastServerMessage,
  type ScreencastFrame,
} from "@sciretriever/contracts";
import { startWorkbenchHttp } from "../src/workbench/http.js";
import { createSyntheticScreencastSession } from "../src/workbench/synthetic-screencast.js";
import {
  workbenchLogin,
  workbenchTestAccess,
} from "./workbench-auth-fixture.js";
async function setup() {
  const fixture = createSyntheticScreencastSession({ automatic: false });
  const http = await startWorkbenchHttp({
    session: fixture.session,
    access: workbenchTestAccess,
    assets: new Map([["/", { body: "synthetic", contentType: "text/html" }]]),
  });
  const auth = await workbenchLogin(http.origin);
  const root = await fetch(http.origin, { headers: { Cookie: auth } });
  await root.text();
  const cookie = [
    auth,
    ...root.headers.getSetCookie().map((c) => c.split(";")[0]),
  ].join("; ");
  const grant = async () => {
    const response = await fetch(`${http.origin}/api/clients`, {
      method: "POST",
      headers: {
        Origin: http.origin,
        Cookie: cookie,
        "Content-Type": "application/json",
        "X-Workbench-Init": "1",
      },
      body: "{}",
    });
    expect(response.status).toBe(201);
    return (await response.json()) as { client_id: string; csrf: string };
  };
  const sockets: WebSocket[] = [];
  const socket = async (
    headers: Record<string, string> = { Origin: http.origin, Cookie: cookie },
  ) => {
    const ws = new WebSocket(
      http.origin.replace("http:", "ws:") + "/api/screencast",
      SCREENCAST_PROTOCOL,
      { headers },
    );
    sockets.push(ws);
    ws.on("error", () => {});
    return ws;
  };
  const connect = async (existing?: { client_id: string; csrf: string }) => {
    const client = existing ?? (await grant());
    const ws = await socket(),
      messages: ScreencastServerMessage[] = [],
      frames: ScreencastFrame[] = [];
    ws.on("message", (bytes, binary) => {
      if (binary)
        frames.push(
          decodeScreencastFrame(new Uint8Array(bytes as Buffer)).frame,
        );
      else
        messages.push(parseScreencastServerMessage(JSON.parse(String(bytes))));
    });
    await once(ws, "open");
    ws.send(
      JSON.stringify({
        type: "hello",
        protocol_version: 1,
        client_id: client.client_id,
        csrf: client.csrf,
      }),
    );
    await vi.waitFor(() =>
      expect(messages.some((m) => m.type === "ready")).toBe(true),
    );
    ws.send(
      JSON.stringify({ type: "subscribe", session_id: fixture.session.id }),
    );
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0));
    const state = () =>
      messages
        .filter(
          (m): m is Extract<ScreencastServerMessage, { type: "state" }> =>
            m.type === "state",
        )
        .at(-1)!;
    return {
      ws,
      messages,
      frames,
      client,
      state,
      send: (message: unknown) => ws.send(JSON.stringify(message)),
    };
  };
  return {
    ...fixture,
    http,
    cookie,
    grant,
    connect,
    socket,
    close: async () => {
      for (const ws of sockets) ws.terminate();
      await http.close();
      await fixture.session.close();
    },
  };
}
it("requires login, same Origin and a client-bound CSRF hello before starting any encoder", async () => {
  const f = await setup();
  try {
    for (const headers of [
      { Origin: f.http.origin },
      { Cookie: f.cookie },
      { Origin: "http://127.0.0.1:1", Cookie: f.cookie },
    ]) {
      const ws = await f.socket(headers);
      await expect(once(ws, "open")).rejects.toBeDefined();
    }
    const a = await f.grant(),
      b = await f.grant();
    const invalid = await f.socket();
    await once(invalid, "open");
    const closed = once(invalid, "close");
    invalid.send(
      JSON.stringify({
        type: "hello",
        protocol_version: 1,
        client_id: a.client_id,
        csrf: b.csrf,
      }),
    );
    await closed;
    expect(f.source.starts).toBe(0);
    expect(
      (
        await fetch(
          `${f.http.origin}/api/frame?client_id=${a.client_id}&frame_seq=1`,
          { headers: { Cookie: f.cookie } },
        )
      ).status,
    ).toBe(404);
  } finally {
    await f.close();
  }
});
it("authenticates, delivers a binary frame, applies a single static click, rejects replay and returns control after a fresh observation", async () => {
  const f = await setup();
  try {
    const c = await f.connect(),
      frame = c.frames[0]!;
    c.send({
      type: "ack",
      subscription_id: frame.subscription_id,
      frame_id: frame.frame_id,
      stream_epoch: frame.stream_epoch,
    });
    const {
      session_id,
      article_id,
      page_id,
      document_generation,
      document_id,
    } = frame;
    const input = {
      type: "input",
      subscription_id: frame.subscription_id,
      frame_id: frame.frame_id,
      seq: 1,
      control_epoch: c.state().control_epoch,
      first: true,
      document: {
        session_id,
        article_id,
        page_id,
        document_generation,
        document_id,
      },
      input: {
        kind: "mouse",
        action: "down",
        x: 40,
        y: 40,
        button: "left",
        buttons: 1,
        click_count: 1,
        modifiers: 0,
      },
    };
    c.send(input);
    await vi.waitFor(() =>
      expect(c.messages).toContainEqual(
        expect.objectContaining({
          type: "input-result",
          seq: 1,
          status: "applied",
        }),
      ),
    );
    expect(c.state()).toMatchObject({
      control: "controlling",
      agent_paused: true,
    });
    await vi.waitFor(() => expect(c.frames.length).toBe(2));
    c.send(input);
    await vi.waitFor(() =>
      expect(c.messages).toContainEqual(
        expect.objectContaining({
          type: "input-result",
          seq: 1,
          status: "rejected",
        }),
      ),
    );
    expect(f.source.inputs).toBe(1);
    const snapshot = vi.spyOn(f.page, "snapshot");
    c.send({
      type: "release",
      subscription_id: frame.subscription_id,
      seq: 2,
      control_epoch: c.state().control_epoch,
    });
    await vi.waitFor(() =>
      expect(c.messages).toContainEqual(
        expect.objectContaining({
          type: "input-result",
          seq: 2,
          status: "applied",
        }),
      ),
    );
    expect(snapshot).toHaveBeenCalledOnce();
    expect(c.state().control).toBe("watching");
    expect(JSON.stringify(c.messages)).not.toContain("Synthetic local content");
    c.send({ type: "unsubscribe" });
    await vi.waitFor(() => expect(f.source.stops).toBe(1));
  } finally {
    await f.close();
  }
});
it("keeps at most the configured in-flight frames and newest pending frame through slow ACKs", async () => {
  const f = await setup();
  try {
    const c = await f.connect(),
      first = c.frames[0]!;
    for (let i = 0; i < 70; i++) f.source.emit();
    await new Promise<void>((r) => setImmediate(r));
    expect(c.frames).toHaveLength(1);
    c.send({
      type: "ack",
      subscription_id: first.subscription_id,
      frame_id: first.frame_id,
      stream_epoch: first.stream_epoch,
    });
    await vi.waitFor(() => expect(c.frames).toHaveLength(2));
    expect(c.frames[1]!.frame_id).toBe(71);
    expect(f.source.starts).toBe(1);
  } finally {
    await f.close();
  }
});
it("replaces a reconnecting socket without letting the old close revoke its successor, and stops on logout", async () => {
  const f = await setup();
  try {
    const a = await f.connect(),
      b = await f.connect(a.client);
    await vi.waitFor(() => expect(a.ws.readyState).toBe(WebSocket.CLOSED));
    expect(b.ws.readyState).toBe(WebSocket.OPEN);
    expect(f.source.stops).toBe(1);
    expect(f.source.starts).toBe(2);
    const response = await fetch(`${f.http.origin}/auth/logout`, {
      method: "POST",
      headers: {
        Origin: f.http.origin,
        Cookie: f.cookie,
        "Content-Type": "application/json",
        "X-Workbench-Init": "1",
      },
      body: "{}",
    });
    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(b.ws.readyState).toBe(WebSocket.CLOSED));
    await vi.waitFor(() => expect(f.source.stops).toBe(2));
  } finally {
    await f.close();
  }
});
