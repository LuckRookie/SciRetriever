import { parseStrictJsonObject } from "@sciretriever/contracts";
import {
  bundlePreview,
  issueCredentialGrant,
  readCredential,
  type CredentialBundle,
} from "../../../configuration/credentials.js";
import type { NetworkBudgetCoordinator } from "../../../network/budget.js";
import type { ConnectionDependencies } from "../../../network/connection.js";
import { NetworkHttpError } from "../../../network/http.js";
import { NetworkPolicyError, type Resolver } from "../../../network/policy.js";
import {
  ProbeRequestError,
  readOnlyProbeRequest,
} from "../../../network/probe.js";
import { ParsingFailure } from "../../ports.js";
import { MINERU_PROTOCOL, MINERU_RELEASE } from "./profile.js";

/** Closed health-only classification: no submit, poll, archive or upload. */
export class MinerUHealthError extends Error {
  constructor(
    readonly code:
      | "parser-unhealthy"
      | "parser-release-mismatch"
      | "parser-protocol-mismatch"
      | "parser-response-invalid"
      | "parser-unreachable"
      | "parser-redirect-refused"
      | "parser-credential-rejected"
      | "parser-credential-unavailable",
  ) {
    super("mineru health probe failed");
    this.name = "MinerUHealthError";
  }
}

export interface MinerUHealthReport {
  readonly status: "healthy";
  readonly version: "3.4.4";
  readonly protocol_version: 2;
  readonly profile: string | null;
}

export interface MinerUHealthProbe {
  /** The exact health endpoint the probe may request. */
  readonly endpoint: string;
  readonly origin: string;
  health(signal?: AbortSignal): Promise<MinerUHealthReport>;
}

const HEALTH_KEYS = ["protocol_version", "status", "version"];

function responseObject(body: Uint8Array): Record<string, unknown> {
  let value: unknown;
  try {
    value = parseStrictJsonObject(
      new TextDecoder("utf-8", { fatal: true }).decode(body),
    );
  } catch {
    throw new MinerUHealthError("parser-response-invalid");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new MinerUHealthError("parser-response-invalid");
  const record = value as Record<string, unknown>;
  if (HEALTH_KEYS.some((key) => !(key in record)))
    throw new MinerUHealthError("parser-response-invalid");
  return record;
}

export function parseMinerUHealth(body: Uint8Array): MinerUHealthReport {
  const record = responseObject(body);
  if (record.status !== "healthy")
    throw new MinerUHealthError("parser-unhealthy");
  if (record.version !== MINERU_RELEASE)
    throw new MinerUHealthError("parser-release-mismatch");
  if (record.protocol_version !== MINERU_PROTOCOL)
    throw new MinerUHealthError("parser-protocol-mismatch");
  if (record.profile !== undefined) {
    if (
      typeof record.profile !== "string" ||
      !record.profile.trim() ||
      /[\p{Cc}\p{Cf}]/u.test(record.profile)
    )
      throw new MinerUHealthError("parser-response-invalid");
  }
  return Object.freeze({
    status: "healthy" as const,
    version: "3.4.4" as const,
    protocol_version: 2 as const,
    profile: typeof record.profile === "string" ? record.profile : null,
  });
}

/**
 * Build the MinerU `GET health` probe. A remote parser requires the health-only
 * credential grant at the configured origin; a loopback parser never carries a
 * credential. Nothing else of the parser protocol is reachable from here.
 */
export function createMinerUHealthProbe(options: {
  readonly base_url: string;
  readonly connection_mode: "loopback" | "remote" | null;
  readonly credentials: CredentialBundle;
  readonly coordinator: NetworkBudgetCoordinator;
  readonly resolver?: Resolver;
  readonly connection?: ConnectionDependencies;
}): MinerUHealthProbe {
  let base: URL;
  try {
    base = new URL(options.base_url);
  } catch {
    throw new ParsingFailure("parser-unavailable");
  }
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new ParsingFailure("parser-unavailable");
  const loopback = base.protocol === "http:";
  if (
    options.connection_mode === null ||
    loopback !== (options.connection_mode === "loopback")
  )
    throw new ParsingFailure("parser-unavailable");
  const origin = base.origin;
  let credential: string | null = null;
  if (!loopback) {
    const presented = bundlePreview(options.credentials).sections.some(
      (section) =>
        section.section === "mineru" &&
        section.origin === origin &&
        section.fields.some(
          (field) => field.field === "bearer_token" && field.present,
        ),
    );
    if (!presented)
      throw new MinerUHealthError("parser-credential-unavailable");
    try {
      const grant = issueCredentialGrant(
        options.credentials,
        "core",
        "mineru",
        "bearer_token",
        origin,
        "parser-health",
      );
      credential = readCredential(
        options.credentials,
        grant,
        "mineru",
        "bearer_token",
        origin,
        "parser-health",
      );
    } catch {
      throw new MinerUHealthError("parser-credential-unavailable");
    }
  }
  const path = base.pathname.replace(/\/+$/u, "");
  const endpoint = `${origin}${path}/health`;
  return {
    endpoint,
    origin,
    health: async (signal?: AbortSignal): Promise<MinerUHealthReport> => {
      let response;
      try {
        response = await readOnlyProbeRequest({
          url: endpoint,
          headers: [["accept", "application/json"]],
          ...(credential === null
            ? {}
            : {
                credential_headers: [
                  ["authorization", `Bearer ${credential}`],
                ] as const,
              }),
          coordinator: options.coordinator,
          ...(options.resolver ? { resolver: options.resolver } : {}),
          ...(options.connection ? { connection: options.connection } : {}),
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        if (
          error instanceof NetworkHttpError ||
          error instanceof NetworkPolicyError ||
          error instanceof ProbeRequestError
        )
          throw new MinerUHealthError("parser-unreachable");
        throw error;
      }
      if (response.status === 401 || response.status === 403)
        throw new MinerUHealthError("parser-credential-rejected");
      if ([301, 302, 303, 307, 308].includes(response.status))
        throw new MinerUHealthError("parser-redirect-refused");
      if (response.status !== 200)
        throw new MinerUHealthError("parser-unreachable");
      return parseMinerUHealth(response.body);
    },
  };
}
