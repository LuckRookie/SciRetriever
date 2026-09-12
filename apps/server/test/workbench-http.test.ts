import { request as httpRequest } from "node:http";
import { describe, expect, it } from "vitest";
import { startWorkbenchHttp } from "../src/workbench/http.js";
import { WorkbenchSession } from "../src/workbench/session.js";
import { parseWorkbenchView } from "@sciretriever/contracts";

function request(
  origin: string,
  path: string,
  method = "GET",
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
}> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(origin + path, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          status: res.statusCode!,
          headers: res.headers,
          text: Buffer.concat(chunks).toString(),
        }),
      );
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
describe("authenticated loopback workbench API", () => {
  it("enforces Host, Origin, session cookie, per-tab CSRF and strict commands; reconnect reads the same page", async () => {
    let calls = 0;
    let selected = "";
    const session = new WorkbenchSession(
      "article-1",
      {
        id: "page-1",
        title: async () => "Fixture",
        url: () => "http://127.0.0.1/article",
        navigate: async () => {},
        close: async () => {},
        snapshot: async () => ({
          url: "http://127.0.0.1/article",
          title: "Fixture",
          document_generation: 3,
          viewport: { width: 800, height: 600, device_scale_factor: 1 },
          screenshot: new Uint8Array([1, 2]),
        }),
        apply: async () => {
          calls++;
        },
      },
      {
        max_actions: 10,
        max_model_calls: 2,
        max_retries: 2,
        max_bytes: 10000,
        deadline_ms: 60000,
      },
      undefined,
      "http-session",
      async () => {},
      undefined,
      async (articleId) => {
        selected = articleId;
      },
    );
    await session.refresh();
    const server = await startWorkbenchHttp({
      session,
      tabs: {
        list: async () => [
          {
            id: "page-1",
            url: "http://127.0.0.1/article",
            title: "Fixture",
            active: true,
            opener_id: null,
          },
        ],
        activate: async () => {},
      },
      configuration: {
        status: async () => ({
          version: 1,
          network_performed: false,
          browser_launched: false,
          items: [
            {
              owner: "browser",
              target: "browser",
              state: "ready",
              code: "ready",
              next_action: "none",
            },
          ],
          credentials: { sources: [], models: [], mineru: false },
        }),
      },
      jobs: {
        list: async () => [{ job_id: "job-1", status: "queued" }],
        get: async (jobId) => ({ job_id: jobId, status: "queued" }),
        targets: async (jobId) => [
          { target_id: `${jobId}-target`, stage: "queued" },
        ],
        attempts: async (targetId) => [
          { target_id: targetId, status: "completed" },
        ],
        events: async (jobId) => [
          { job_id: jobId, sequence: 0, kind: "created" },
        ],
        policy: async () => ({ mode: "never", max_retries: 0 }),
        budget: async (jobId) => ({
          job_id: jobId,
          attempts: 0,
          max_attempts: 10,
        }),
        interventions: async () => [],
        run: async () => [],
        resolveIntervention: async (interventionId, resolution) => ({
          intervention_id: interventionId,
          status: "resolved",
          resolution: { kind: resolution },
        }),
        create: async (input) => ({ job_id: "job-created", input }),
        pause: async (jobId) => ({ job_id: jobId, status: "paused" }),
        resume: async (jobId) => ({ job_id: jobId, status: "queued" }),
        cancel: async (jobId) => ({ job_id: jobId, status: "cancelled" }),
      },
      assets: new Map([
        ["/", { contentType: "text/html", body: "<html></html>" }],
      ]),
    });
    try {
      expect((await request(server.origin, "/api/view")).status).toBe(401);
      expect(
        (await request(server.origin, "/", "GET", { Host: "attacker.test" }))
          .status,
      ).toBe(403);
      expect(
        (
          await request(server.origin, "/", "GET", {
            Origin: "https://attacker.test",
          })
        ).status,
      ).toBe(403);
      const root = await request(server.origin, "/");
      const cookie = (root.headers["set-cookie"] as string[])[0]!.split(
        ";",
      )[0]!;
      expect(root.headers["set-cookie"]![0]).toContain("HttpOnly");
      const headers = {
        Cookie: cookie,
        Origin: server.origin,
        "Content-Type": "application/json",
        "X-Workbench-Init": "1",
      };
      expect(
        (
          await request(
            server.origin,
            "/api/clients",
            "POST",
            { Cookie: cookie, "Content-Type": "application/json" },
            {},
          )
        ).status,
      ).toBe(403);
      const first = await request(
        server.origin,
        "/api/clients",
        "POST",
        headers,
        {},
      );
      expect(first.status).toBe(201);
      const grant = JSON.parse(first.text) as {
        client_id: string;
        csrf: string;
        view: unknown;
      };
      const view = parseWorkbenchView(grant.view);
      const query = `?client_id=${grant.client_id}`;
      const tabs = await request(server.origin, `/api/tabs${query}`, "GET", {
        Cookie: cookie,
      });
      expect(tabs.status).toBe(200);
      expect(JSON.parse(tabs.text)).toMatchObject({
        tabs: [{ id: "page-1", active: true }],
      });
      const tabSwitch = await request(
        server.origin,
        `/api/tabs/activate${query}`,
        "POST",
        { ...headers, "X-Workbench-Csrf": grant.csrf },
        { page_id: "page-1" },
      );
      expect(tabSwitch.status).toBe(200);
      const jobs = await request(
        server.origin,
        `/api/v1/jobs${query}&limit=10`,
        "GET",
        { Cookie: cookie },
      );
      expect(jobs.status).toBe(200);
      expect(JSON.parse(jobs.text)).toMatchObject({
        jobs: [{ job_id: "job-1", status: "queued" }],
      });
      expect(
        (
          await request(
            server.origin,
            `/api/control${query}`,
            "POST",
            headers,
            { kind: "takeover", control_epoch: view.control.epoch },
          )
        ).status,
      ).toBe(403);
      const commandHeaders = { ...headers, "X-Workbench-Csrf": grant.csrf };
      const run = await request(
        server.origin,
        "/api/v1/jobs/job-1/run?client_id=" + grant.client_id,
        "POST",
        commandHeaders,
        {},
      );
      expect(run.status).toBe(200);
      expect(JSON.parse(run.text)).toMatchObject({ results: [] });
      const created = await request(
        server.origin,
        "/api/jobs?client_id=" + grant.client_id,
        "POST",
        commandHeaders,
        { target_kind: "selector", selector: {}, policy_version: "v1" },
      );
      expect(created.status).toBe(201);
      expect(JSON.parse(created.text)).toMatchObject({
        job: { job_id: "job-created" },
      });
      const events = await request(
        server.origin,
        `/api/v1/jobs/job-1/events${query}&after=-1`,
        "GET",
        { Cookie: cookie },
      );
      expect(events.status).toBe(200);
      expect(JSON.parse(events.text)).toMatchObject({
        events: [{ sequence: 0, kind: "created" }],
      });
      const budget = await request(
        server.origin,
        `/api/v1/jobs/job-1/budget${query}`,
        "GET",
        { Cookie: cookie },
      );
      expect(JSON.parse(budget.text)).toMatchObject({
        budget: { job_id: "job-1", attempts: 0, max_attempts: 10 },
      });
      const configuration = await request(
        server.origin,
        `/api/configuration/status${query}`,
        "POST",
        commandHeaders,
        {},
      );
      expect(configuration.status).toBe(200);
      expect(JSON.parse(configuration.text)).toMatchObject({
        status: { network_performed: false, browser_launched: false },
      });
      expect(
        (
          await request(
            server.origin,
            `/api/control${query}`,
            "POST",
            commandHeaders,
            { kind: "takeover", control_epoch: view.control.epoch },
          )
        ).status,
      ).toBe(200);
      const current = parseWorkbenchView(
        JSON.parse(
          (
            await request(server.origin, `/api/view${query}`, "GET", {
              Cookie: cookie,
            })
          ).text,
        ),
      );
      expect(current.control.controller_id).toBe(grant.client_id);
      expect(current.observation!.page_id).toBe(view.observation!.page_id);
      expect(
        (
          await request(
            server.origin,
            `/api/frame${query}&frame_seq=999`,
            "GET",
            { Cookie: cookie },
          )
        ).status,
      ).toBe(409);
      const frame = await request(
        server.origin,
        `/api/frame${query}&frame_seq=${current.observation!.frame_seq}`,
        "GET",
        { Cookie: cookie },
      );
      expect(frame.status).toBe(200);
      expect(frame.headers["content-type"]).toBe("image/jpeg");
      const target = await request(
        server.origin,
        `/api/target${query}`,
        "POST",
        commandHeaders,
        { article_id: "article-2", control_epoch: current.control.epoch },
      );
      expect(target.status).toBe(200);
      expect(selected).toBe("article-2");
      expect(
        parseWorkbenchView((JSON.parse(target.text) as { view: unknown }).view)
          .article_id,
      ).toBe("article-2");
      expect(
        (
          await request(
            server.origin,
            `/api/action${query}`,
            "POST",
            commandHeaders,
            { url: "https://attacker.test" },
          )
        ).status,
      ).toBe(409);
      expect(calls).toBe(0);
      expect(
        (
          await request(
            server.origin,
            `/api/view${query}&token=private`,
            "GET",
            { Cookie: cookie },
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await request(
            server.origin,
            `/api/control${query}`,
            "POST",
            commandHeaders,
            { kind: "agent-step", control_epoch: current.control.epoch },
          )
        ).status,
      ).toBe(409);
      const abort = new AbortController();
      const stream = await fetch(`${server.origin}/api/events${query}`, {
        headers: { Cookie: cookie },
        signal: abort.signal,
      });
      const reader = stream.body!.getReader();
      const event = await reader.read();
      expect(new TextDecoder().decode(event.value)).toContain("event: view");
      abort.abort();
      const reconnect = await fetch(`${server.origin}/api/events${query}`, {
        headers: { Cookie: cookie },
      });
      expect(reconnect.status).toBe(200);
      const reconnectReader = reconnect.body!.getReader();
      const reconnectEvent = await reconnectReader.read();
      expect(new TextDecoder().decode(reconnectEvent.value)).toContain(
        "event: view",
      );
      await reconnectReader.cancel();
      const reconnected = await request(
        server.origin,
        `/api/view${query}`,
        "GET",
        { Cookie: cookie },
      );
      expect(reconnected.status).toBe(200);
      expect(parseWorkbenchView(JSON.parse(reconnected.text)).session_id).toBe(
        session.id,
      );
      expect(reconnected.text).not.toContain(grant.csrf);
      expect(reconnected.text).not.toContain(cookie);
    } finally {
      await server.close();
      await session.close();
    }
  });
});
