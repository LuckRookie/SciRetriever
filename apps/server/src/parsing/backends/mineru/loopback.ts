import { NetworkBudgetCoordinator } from "../../../network/budget.js";
import type { RawParseProfile } from "@sciretriever/contracts";
import { normalizeUrl, resolveDestination } from "../../../network/policy.js";
import { requestOnce } from "../../../network/http.js";
import { MinerUParser, type MinerUHttpTransport } from "./http.js";
import { createMinerUProtocolTransport } from "./protocol.js";
import {
  ParsingFailure,
  type RawParserBackend,
  type ParserRequest,
} from "../../ports.js";

function fail(): never {
  throw new ParsingFailure("parser-unavailable");
}

/** Loopback network boundary; the task protocol is shared with remote services. */
export class MinerULoopbackParser implements RawParserBackend {
  private readonly parser: MinerUParser;

  constructor(options: {
    readonly baseUrl: string;
    readonly modelIdentity: string;
    readonly coordinator: NetworkBudgetCoordinator;
    readonly timeoutMs?: number;
    readonly pollIntervalMs?: number;
  }) {
    let base: URL;
    try {
      base = new URL(options.baseUrl);
    } catch {
      fail();
    }
    if (
      base.protocol !== "http:" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      !options.modelIdentity.trim() ||
      !(options.coordinator instanceof NetworkBudgetCoordinator)
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
    const transport: MinerUHttpTransport = {
      request: async (url, input) => {
        const destination = await resolveDestination(
          url,
          (hostname) =>
            hostname === "localhost"
              ? ["127.0.0.1"]
              : [hostname.replace(/^\[|\]$/gu, "")],
          policy,
        );
        const archive = new URL(url).pathname.endsWith("/result");
        const maxResponseBytes = archive ? 64 * 1024 * 1024 : 1024 * 1024;
        return requestOnce(destination, destination.addresses[0]!, {
          method: input.method ?? "POST",
          headers: Object.entries(input.headers),
          ...(input.method === "GET" ? {} : { body: input.body }),
          timeoutMs: 120000,
          maxResponseBytes,
          ...(input.signal ? { signal: input.signal } : {}),
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
        });
      },
    };
    this.parser = new MinerUParser(
      createMinerUProtocolTransport(transport, options),
      options,
    );
  }

  identity(profile: RawParseProfile) {
    return this.parser.identity(profile);
  }

  parseRaw(
    request: ParserRequest,
    profile: RawParseProfile,
    signal?: AbortSignal,
  ) {
    return this.parser.parseRaw(request, profile, signal);
  }
}
