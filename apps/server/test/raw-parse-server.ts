import { createServer } from "node:http";
import {
  parseRawParseProfile,
  type RawParseProfile,
} from "@sciretriever/contracts";
import { rawParseArchive } from "./raw-parse-fixture.js";

export type RawParseFault =
  | "backend"
  | "missing-v2"
  | "unknown-type"
  | "failure"
  | "timeout";
/** Offline test service. Production loopback.ts remains the real network adapter. */
export async function fakeRawParseServer(
  faults: Partial<Record<RawParseProfile, RawParseFault>> = {},
) {
  const submitted: { profile: RawParseProfile; fields: string }[] = [];
  const tasks = new Map<string, RawParseProfile>();
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/health") {
      response.end(
        JSON.stringify({
          status: "healthy",
          version: "3.4.4",
          protocol_version: 2,
          queued_tasks: 0,
          processing_tasks: 0,
          completed_tasks: 0,
          failed_tasks: 0,
          max_concurrent_requests: 1,
          processing_window_size: 64,
          task_retention_seconds: 86400,
          task_cleanup_interval_seconds: 300,
        }),
      );
      return;
    }
    if (request.method === "POST" && request.url === "/tasks") {
      const parts: Uint8Array[] = [];
      for await (const p of request) parts.push(p as Uint8Array);
      const fields = Buffer.concat(parts).toString("latin1");
      let profile: RawParseProfile;
      try {
        profile = parseRawParseProfile(
          /name="backend"\r\n\r\n([^\r]+)/u.exec(fields)?.[1],
        );
      } catch {
        response.writeHead(400);
        response.end("{}");
        return;
      }
      const id = `synthetic-${tasks.size}`;
      tasks.set(id, profile);
      submitted.push({ profile, fields });
      response.writeHead(202);
      response.end(
        JSON.stringify({
          task_id: id,
          status: "pending",
          backend: profile,
          file_names: ["synthetic"],
          queued_ahead: 0,
        }),
      );
      return;
    }
    const match = /^\/tasks\/(synthetic-\d+)(\/result)?$/u.exec(
      request.url ?? "",
    );
    const profile = match && tasks.get(match[1]!);
    if (!profile) {
      response.writeHead(404);
      response.end("{}");
      return;
    }
    if (!match![2]) {
      response.end(
        JSON.stringify({
          task_id: match![1],
          backend: profile,
          status:
            faults[profile] === "timeout"
              ? "processing"
              : faults[profile] === "failure"
                ? "failed"
                : "completed",
          error: null,
        }),
      );
      return;
    }
    response.setHeader("content-type", "application/zip");
    response.end(
      rawParseArchive(profile, {
        ...(faults[profile] === "backend" ? { backend: "wrong" } : {}),
        ...(faults[profile] === "missing-v2" ? { omitV2: true } : {}),
        ...(faults[profile] === "unknown-type"
          ? {
              blocks: [
                [{ type: "future_type", bbox: [1, 1, 90, 90], content: {} }],
              ],
            }
          : {}),
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("synthetic parser failed to bind");
  return {
    url: `http://127.0.0.1:${address.port}`,
    submitted,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    },
  };
}
