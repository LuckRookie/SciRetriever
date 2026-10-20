import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  parseStrictJsonObject,
  parseRawParseProfile,
} from "@sciretriever/contracts";
import { ParsingFailure } from "../../ports.js";
import type { MinerUHttpTransport } from "./http.js";
import { parseMinerUHealth } from "./health.js";
import { mineruRequestFields } from "./profile.js";

function fail(): never {
  throw new ParsingFailure("parser-unavailable");
}

function task(body: Uint8Array, expectedId?: string) {
  const value = parseStrictJsonObject(body);
  if (
    typeof value.task_id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value.task_id) ||
    (expectedId !== undefined && value.task_id !== expectedId) ||
    typeof value.status !== "string" ||
    !["pending", "processing", "completed", "failed"].includes(value.status)
  )
    fail();
  return { id: value.task_id, status: value.status };
}

/** One protocol for both loopback and authorized remote operator services. */
export function createMinerUProtocolTransport(
  transport: MinerUHttpTransport,
  options: {
    readonly baseUrl: string;
    readonly timeoutMs?: number;
    readonly pollIntervalMs?: number;
  },
): MinerUHttpTransport {
  const timeoutMs = options.timeoutMs;
  const pollIntervalMs = options.pollIntervalMs ?? 2000;
  if (
    (timeoutMs !== undefined &&
      (!Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > 3600000)) ||
    !Number.isSafeInteger(pollIntervalMs) ||
    pollIntervalMs < 1 ||
    pollIntervalMs > 30000
  )
    fail();
  const base = new URL(options.baseUrl);
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    fail();
  const root = base.toString().replace(/\/+$/u, "");
  return {
    request: async (_url, input) => {
      if (input.signal?.aborted) throw new ParsingFailure("parser-cancelled");
      const deadline = new AbortController();
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => deadline.abort(), timeoutMs);
      timer?.unref();
      const signal = input.signal
        ? AbortSignal.any([input.signal, deadline.signal])
        : deadline.signal;
      const check = () => {
        if (input.signal?.aborted) throw new ParsingFailure("parser-cancelled");
        if (deadline.signal.aborted) fail();
      };
      const request = async (
        suffix: string,
        method: "GET" | "POST",
        body = new Uint8Array(),
        contentType?: string,
      ) => {
        check();
        const archive = suffix.endsWith("/result");
        const response = await transport.request(`${root}/${suffix}`, {
          method,
          body,
          headers: {
            accept: archive ? "application/zip" : "application/json",
            ...(contentType ? { "content-type": contentType } : {}),
          },
          signal,
        });
        check();
        const media = response.headers
          .filter(([name]) => name.toLowerCase() === "content-type")
          .map(([, value]) => value.split(";", 1)[0]!.trim().toLowerCase());
        if (
          response.status !== (method === "POST" ? 202 : 200) ||
          response.body.byteLength >
            (archive ? 64 * 1024 * 1024 : 1024 * 1024) ||
          media.length !== 1 ||
          media[0] !== (archive ? "application/zip" : "application/json")
        )
          fail();
        return response;
      };
      try {
        const profile = parseRawParseProfile(
          input.headers["x-sciretriever-profile"] ?? "vlm-engine",
        );
        parseMinerUHealth((await request("health", "GET")).body);
        const boundary = `sciretriever-${randomUUID().replaceAll("-", "")}`;
        const body = Buffer.concat([
          ...mineruRequestFields(profile).map(([key, value]) =>
            Buffer.from(
              `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`,
            ),
          ),
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="document.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
          ),
          Buffer.from(input.body),
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]);
        let current = task(
          (
            await request(
              "tasks",
              "POST",
              body,
              `multipart/form-data; boundary=${boundary}`,
            )
          ).body,
        );
        const suffix = `tasks/${encodeURIComponent(current.id)}`;
        while (current.status !== "completed") {
          if (current.status === "failed") fail();
          await delay(pollIntervalMs, undefined, { signal });
          current = task((await request(suffix, "GET")).body, current.id);
        }
        // Never follow task URLs from a response, including same-origin-looking URLs.
        return await request(`${suffix}/result`, "GET");
      } catch (error) {
        check();
        if (error instanceof ParsingFailure) throw error;
        throw new ParsingFailure("parser-unavailable");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
