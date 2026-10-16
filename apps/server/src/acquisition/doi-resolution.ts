import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { NetworkBudgetCoordinator } from "../network/budget.js";
import type { ConnectionDependencies } from "../network/connection.js";
import { requestOnce, type HttpResponse } from "../network/http.js";
import {
  classifyAddress,
  NetworkPolicyError,
  normalizeUrl,
  resolveDestination,
  type Resolver,
} from "../network/policy.js";
import { publicWebService } from "../providers/registry.js";
import {
  DEFAULT_PDF_DOWNLOAD_MAX_BYTES,
  hasPdfHeader,
} from "./sources/public.js";
import { AcquisitionRouteError } from "./tiered.js";

/** Resolve the DOI's declared article location without requesting the publisher. */
export async function resolveDoiLanding(
  url: string,
  coordinator: NetworkBudgetCoordinator,
  signal: AbortSignal,
  options: {
    readonly resolver?: Resolver;
    readonly connection?: ConnectionDependencies;
    /** Reuse this response only in the current operation; never persist or log it. */
    readonly on_response?: (response: HttpResponse) => void;
  } = {},
): Promise<string | null> {
  signal.throwIfAborted();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError("DOI resolution URL is invalid");
  }
  if (
    parsed.origin !== "https://doi.org" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    throw new TypeError("DOI resolution URL is invalid");
  const policy = {
    allowed_schemes: ["https"] as const,
    allowed_classes: ["public"] as const,
    allowed_ports: [{ scheme: "https" as const, port: 443 }],
  };
  const destination = await resolveDestination(
    url,
    options.resolver ??
      (async (hostname) =>
        (await lookup(hostname, { all: true })).map(
          (record) => record.address,
        )),
    policy,
  );
  signal.throwIfAborted();
  const service = publicWebService(url);
  const response = await requestOnce(destination, destination.addresses[0]!, {
    method: "GET",
    headers: [["accept", "text/html"]],
    timeoutMs: 15_000,
    maxResponseBytes: DEFAULT_PDF_DOWNLOAD_MAX_BYTES,
    signal,
    ...(options.connection ? { connection: options.connection } : {}),
    budget: {
      coordinator,
      scope: service.quotaGroup,
      limits: {
        ...service.policy,
        maxResponseBytes: DEFAULT_PDF_DOWNLOAD_MAX_BYTES,
        maxRedirects: 0,
        maxRetries: 0,
      },
    },
  });
  options.on_response?.(response);
  signal.throwIfAborted();
  // The resolver can already have delivered PDF bytes. Keep them for the common
  // reader/publication path; Network has independently applied any rate feedback.
  if (response.status >= 200 && response.status < 300 && hasPdfHeader(response))
    return null;
  if (
    response.status === 429 ||
    response.retry_after_ms !== undefined ||
    response.headers.some(([key]) => key.toLowerCase() === "retry-after")
  )
    throw new AcquisitionRouteError(
      "rate-limited",
      "DOI resolution is rate limited.",
      true,
      { retry_after_ms: response.retry_after_ms },
    );
  if (response.status === 401)
    throw new AcquisitionRouteError(
      "http-response-failed",
      "DOI resolution requires authentication.",
      false,
    );
  if (response.status >= 500)
    throw new AcquisitionRouteError(
      "http-response-failed",
      "DOI resolution service is unavailable.",
      true,
    );
  if (![301, 302, 303, 307, 308].includes(response.status)) return null;
  const location = response.headers.find(
    ([key]) => key.toLowerCase() === "location",
  )?.[1];
  if (!location) return null;
  if (/\s|[\p{Cc}\p{Cf}]|\\/u.test(location)) throw new NetworkPolicyError();
  let target: URL;
  try {
    target = new URL(location, url);
  } catch (error) {
    throw new AcquisitionRouteError(
      "source-discovery-failed",
      "DOI resolution returned an invalid article location.",
      true,
      { cause: error },
    );
  }
  target.hash = "";
  // This is a locator, not a dispatch. DNS admission is repeated by its eventual owner.
  const locationPolicy = {
    ...policy,
    allowed_schemes: ["https", "http"] as const,
    allowed_ports: [
      { scheme: "https" as const, port: 443 },
      { scheme: "http" as const, port: 80 },
    ],
  };
  // Preserve Network's raw-path checks before URL canonicalization can erase
  // traversal or encoded dots. A relative spelling needs only a validation base.
  const rawTarget = /^[a-z][a-z\d+.-]*:/iu.test(location)
    ? location
    : location.startsWith("//")
      ? `${parsed.protocol}${location}`
      : `${parsed.origin}/${location.replace(/^\//u, "")}`;
  normalizeUrl(rawTarget.split("#", 1)[0]!, locationPolicy);
  const normalized = normalizeUrl(target.toString(), locationPolicy);
  if (
    isIP(normalized.hostname) &&
    classifyAddress(normalized.hostname) !== "public"
  )
    throw new NetworkPolicyError();
  return target.toString();
}
