import { randomUUID } from "node:crypto";
import { parseStrictJsonObject } from "@sciretriever/contracts";
import { NetworkBudgetCoordinator } from "../../../network/budget.js";
import { normalizeUrl, resolveDestination } from "../../../network/policy.js";
import { requestOnce, type HttpResponse } from "../../../network/http.js";
import { MinerUParser, type MinerUHttpTransport } from "./http.js";
import {
  ParsingFailure,
  type ParserBackend,
  type ParserRequest,
  type StagedParserOutput,
} from "../../ports.js";

function fail(): never {
  throw new ParsingFailure("parser-unavailable");
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== keys.sort().join()
  )
    fail();
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string") fail();
  return value;
}
const fields: readonly (readonly [string, string])[] = [
  ["backend", "vlm-engine"],
  ["parse_method", "auto"],
  ["formula_enable", "true"],
  ["table_enable", "true"],
  ["image_analysis", "true"],
  ["return_md", "false"],
  ["return_middle_json", "true"],
  ["return_model_output", "true"],
  ["return_content_list", "true"],
  ["return_images", "true"],
  ["response_format_zip", "true"],
  ["return_original_file", "false"],
  ["client_side_output_generation", "false"],
];

/** Loopback transport for the operator-managed MinerU backend protocol. */
export class MinerULoopbackParser implements ParserBackend {
  private readonly parser: MinerUParser;

  constructor(options: {
    readonly baseUrl: string;
    readonly modelIdentity: string;
    readonly coordinator: NetworkBudgetCoordinator;
    readonly timeoutMs?: number;
  }) {
    let base: URL;
    try {
      base = new URL(options.baseUrl);
    } catch {
      fail();
    }
    const timeoutMs = options.timeoutMs ?? 180000;
    if (
      base.protocol !== "http:" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      !options.modelIdentity.trim() ||
      !(options.coordinator instanceof NetworkBudgetCoordinator) ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 3600000
    )
      fail();
    const destinationAddress = base.hostname === "[::1]" ? "::1" : "127.0.0.1";
    const policy = {
      allowed_schemes: ["http"] as const,
      allowed_classes: ["loopback"] as const,
      allowed_addresses: [destinationAddress],
      allowed_ports: [
        { scheme: "http" as const, port: Number(base.port || 80) },
      ],
    };
    try {
      normalizeUrl(options.baseUrl, policy);
    } catch {
      fail();
    }
    const root = base.pathname.replace(/\/$/u, "");
    const requestService = async (
      operation: "health" | "submit" | "poll" | "archive",
      pdf: Uint8Array,
      taskId: string | undefined,
      signal?: AbortSignal,
    ) => {
      if (signal?.aborted) throw new ParsingFailure("parser-cancelled");
      let suffix = "health";
      let method = "GET";
      let body: Uint8Array | undefined;
      const headers: [string, string][] = [
        [
          "accept",
          operation === "archive" ? "application/zip" : "application/json",
        ],
      ];
      if (operation === "submit") {
        const boundary = `sciretriever-${randomUUID().replaceAll("-", "")}`;
        body = Buffer.concat([
          ...fields.map(([key, value]) =>
            Buffer.from(
              `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`,
            ),
          ),
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="document.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
          ),
          Buffer.from(pdf),
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]);
        headers.push([
          "content-type",
          `multipart/form-data; boundary=${boundary}`,
        ]);
        suffix = "tasks";
        method = "POST";
      } else if (operation === "poll" || operation === "archive") {
        if (!taskId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(taskId))
          fail();
        suffix = `tasks/${encodeURIComponent(taskId)}${operation === "archive" ? "/result" : ""}`;
      }
      const url = new URL(base);
      url.pathname = `${root}/${suffix}`.replace(/\/\//gu, "/");
      const destination = await resolveDestination(
        url.toString(),
        (hostname) =>
          hostname === "localhost"
            ? ["127.0.0.1"]
            : [hostname.replace(/^\[|\]$/gu, "")],
        policy,
      );
      const maxResponseBytes =
        operation === "archive" ? 64 * 1024 * 1024 : 1024 * 1024;
      const response = await requestOnce(
        destination,
        destination.addresses[0]!,
        {
          method,
          headers,
          ...(body ? { body } : {}),
          timeoutMs:
            operation === "health"
              ? 10000
              : operation === "poll"
                ? 30000
                : 120000,
          maxResponseBytes,
          ...(signal ? { signal } : {}),
          budget: {
            coordinator: options.coordinator,
            scope: "mineru",
            limits: {
              maxConcurrency: 1,
              maxHostConcurrency: 1,
              maxResponseBytes,
              maxRedirects: 0,
              maxRetries: 0,
            },
          },
        },
      );
      const media = response.headers
        .filter(([key]) => key.toLowerCase() === "content-type")
        .map(([, value]) => value.split(";", 1)[0]!.trim().toLowerCase());
      if (operation === "archive") {
        if ([202, 404, 409].includes(response.status))
          return {
            status: response.status,
            body: new Uint8Array(),
            headers: [["content-type", "application/json"]] as const,
          };
        if (
          response.status !== 200 ||
          media.length !== 1 ||
          media[0] !== "application/zip"
        )
          fail();
        return response;
      }
      if (operation === "poll" && response.status === 404) return null;
      const expectedStatus = operation === "submit" ? 202 : 200;
      if (
        response.status !== expectedStatus ||
        media.length !== 1 ||
        media[0] !== "application/json"
      )
        fail();
      return parseStrictJsonObject(response.body);
    };

    const transport: MinerUHttpTransport = {
      request: async (_url, requestOptions) => {
        try {
          const health = await requestService(
            "health",
            requestOptions.body,
            undefined,
            requestOptions.signal,
          );
          const healthRecord = object(health, [
            "status",
            "version",
            "protocol_version",
          ]);
          if (
            healthRecord.status !== "healthy" ||
            healthRecord.version !== "3.4.4" ||
            healthRecord.protocol_version !== 2
          )
            fail();
          const submitted = await requestService(
            "submit",
            requestOptions.body,
            undefined,
            requestOptions.signal,
          );
          const task = object(submitted, ["task_id", "status"]);
          const id = text(task.task_id);
          if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(id)) fail();
          let status = text(task.status);
          if (
            !["pending", "processing", "completed", "failed"].includes(status)
          )
            fail();
          for (let attempt = 0; status !== "completed"; attempt += 1) {
            if (status === "failed" || attempt >= 120) fail();
            await new Promise<void>((resolveDelay, rejectDelay) => {
              const timer = setTimeout(resolveDelay, 50);
              requestOptions.signal?.addEventListener(
                "abort",
                () => {
                  clearTimeout(timer);
                  rejectDelay(new ParsingFailure("parser-cancelled"));
                },
                { once: true },
              );
            });
            const polled = await requestService(
              "poll",
              requestOptions.body,
              id,
              requestOptions.signal,
            );
            if (polled === null) fail();
            const current = object(polled, ["task_id", "status"]);
            if (current.task_id !== id) fail();
            status = text(current.status);
            if (
              !["pending", "processing", "completed", "failed"].includes(status)
            )
              fail();
          }
          const archive = await requestService(
            "archive",
            requestOptions.body,
            id,
            requestOptions.signal,
          );
          if (
            !archive ||
            typeof archive !== "object" ||
            !("status" in archive) ||
            !("headers" in archive) ||
            !("body" in archive)
          )
            fail();
          return archive as HttpResponse;
        } catch (error) {
          if (error instanceof ParsingFailure) throw error;
          if (requestOptions.signal?.aborted)
            throw new ParsingFailure("parser-cancelled");
          throw new ParsingFailure("parser-unavailable");
        }
      },
    };
    this.parser = new MinerUParser(transport, {
      baseUrl: options.baseUrl,
      modelIdentity: options.modelIdentity,
    });
    void timeoutMs;
  }

  parse(
    request: ParserRequest,
    signal?: AbortSignal,
  ): Promise<StagedParserOutput> {
    return this.parser.parse(request, signal);
  }
}
