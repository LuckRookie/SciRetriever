import { isIP } from "node:net";

export class NetworkPolicyError extends Error {
  readonly code = "network-policy" as const;
  constructor() {
    super("network policy operation failed");
    this.name = "NetworkPolicyError";
  }
}

export type AddressClass =
  | "public"
  | "private"
  | "loopback"
  | "link-local"
  | "multicast"
  | "unspecified"
  | "reserved";

export interface Origin {
  readonly scheme: "http" | "https";
  readonly hostname: string;
  readonly port: number;
}
export interface NormalizedUrl {
  readonly url: string;
  readonly scheme: "http" | "https";
  readonly hostname: string;
  readonly port: number;
  readonly path: string;
  readonly query: string;
  readonly origin: Origin;
}
export interface DestinationPolicy {
  readonly allowed_schemes?: readonly ("http" | "https")[];
  readonly allowed_classes?: readonly AddressClass[];
  readonly allowed_addresses?: readonly string[];
  readonly allowed_origins?: readonly Origin[];
  readonly allowed_ports?: readonly {
    scheme: "http" | "https";
    port: number;
  }[];
}
export interface ResolvedDestination {
  readonly url: NormalizedUrl;
  readonly addresses: readonly string[];
  readonly classes: readonly AddressClass[];
}
export interface RedirectDecision {
  readonly source: ResolvedDestination;
  readonly destination: ResolvedDestination;
  readonly same_origin: boolean;
  readonly forward_credentials: boolean;
}

export type Resolver = (
  hostname: string,
) => readonly string[] | Promise<readonly string[]>;

const admittedDestinations = new WeakSet<object>();
export function assertResolvedDestination(value: ResolvedDestination): void {
  if (
    typeof value !== "object" ||
    value === null ||
    !admittedDestinations.has(value)
  )
    throw new NetworkPolicyError();
}

const DEFAULT_PORT: Record<"http" | "https", number> = {
  http: 80,
  https: 443,
};
const DEFAULT_SCHEMES = ["https"] as const;
const DEFAULT_CLASSES = ["public"] as const;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const SENSITIVE_QUERY_KEYS = new Set([
  "api_key",
  "apikey",
  "access_token",
  "awsaccesskeyid",
  "auth",
  "authorization",
  "bearer",
  "cookie",
  "credential",
  "credentials",
  "email",
  "id_token",
  "key",
  "password",
  "passwd",
  "refresh_token",
  "secret",
  "sig",
  "signature",
  "token",
]);
const SENSITIVE_QUERY_SUFFIXES = [
  "_credential",
  "_key",
  "_secret",
  "_signature",
  "_token",
];

function invalid(): never {
  throw new NetworkPolicyError();
}
function canonicalIpv4(value: string): string | null {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/u.test(part)))
    return null;
  const numbers = parts.map(Number);
  if (
    numbers.some((part, index) => part > 255 || String(part) !== parts[index])
  )
    invalid();
  return numbers.join(".");
}
function ipv4Number(value: string): number {
  return value
    .split(".")
    .reduce((total, part) => total * 256 + Number(part), 0);
}
function inIpv4(value: string, network: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4Number(value) & mask) === (ipv4Number(network) & mask);
}
function ipv6Groups(value: string): number[] {
  let lower = value.toLowerCase();
  if (lower.includes(".")) {
    const separator = lower.lastIndexOf(":");
    if (separator < 0) invalid();
    const ipv4 = canonicalIpv4(lower.slice(separator + 1));
    if (ipv4 === null) invalid();
    const groups = ipv4Number(ipv4)
      .toString(16)
      .padStart(8, "0")
      .match(/.{4}/gu);
    if (!groups) invalid();
    lower = `${lower.slice(0, separator)}:${groups[0]}:${groups[1]}`;
  }
  if (!/^[0-9a-f:.]+$/u.test(lower) || lower.includes("%")) invalid();
  const halves = lower.split("::");
  if (halves.length > 2) invalid();
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const valid = [...left, ...right].every((part) =>
    /^[0-9a-f]{1,4}$/u.test(part),
  );
  const missing = 8 - left.length - right.length;
  if (
    !valid ||
    (halves.length === 1 && missing !== 0) ||
    (halves.length === 2 && missing < 1)
  )
    invalid();
  return [...left, ...Array.from({ length: missing }, () => "0"), ...right].map(
    (part) => Number.parseInt(part, 16),
  );
}
function normalizedIpv6(value: string): string {
  const groups = ipv6Groups(value);
  let bestStart = -1;
  let bestLength = 0;
  for (let start = 0; start < groups.length; start += 1) {
    if (groups[start] !== 0) continue;
    let end = start;
    while (end < groups.length && groups[end] === 0) end += 1;
    if (end - start > bestLength) {
      bestStart = start;
      bestLength = end - start;
    }
    start = end - 1;
  }
  if (bestStart >= 0 && bestLength > 1) {
    const left = groups
      .slice(0, bestStart)
      .map((part) => part.toString(16))
      .join(":");
    const right = groups
      .slice(bestStart + bestLength)
      .map((part) => part.toString(16))
      .join(":");
    return `${left}::${right}`;
  }
  return groups.map((part) => part.toString(16)).join(":");
}
function ipv6In(value: string, prefix: string, bits: number): boolean {
  const actual = ipv6Groups(value);
  const expected = ipv6Groups(prefix);
  let remaining = bits;
  for (let index = 0; index < 8 && remaining > 0; index += 1) {
    const width = Math.min(remaining, 16);
    const mask = width === 16 ? 0xffff : (0xffff << (16 - width)) & 0xffff;
    if ((actual[index]! & mask) !== (expected[index]! & mask)) return false;
    remaining -= width;
  }
  return true;
}
function canonicalAddress(value: string): string {
  if (typeof value !== "string" || !value || /\s|%/u.test(value)) invalid();
  if (isIP(value) === 4) return canonicalIpv4(value) ?? invalid();
  if (isIP(value) === 6) {
    const normalized = normalizedIpv6(value);
    if (normalized !== value.toLowerCase() && !value.includes(".")) invalid();
    return normalized;
  }
  invalid();
}
function classifyCanonical(value: string): AddressClass {
  const version = isIP(value);
  if (version === 4) {
    if (value === "0.0.0.0") return "unspecified";
    if (inIpv4(value, "127.0.0.0", 8)) return "loopback";
    if (inIpv4(value, "169.254.0.0", 16)) return "link-local";
    if (inIpv4(value, "224.0.0.0", 4)) return "multicast";
    if (
      inIpv4(value, "10.0.0.0", 8) ||
      inIpv4(value, "172.16.0.0", 12) ||
      inIpv4(value, "192.168.0.0", 16) ||
      inIpv4(value, "100.64.0.0", 10) ||
      inIpv4(value, "198.18.0.0", 15)
    )
      return "private";
    if (
      inIpv4(value, "192.0.0.0", 24) ||
      inIpv4(value, "192.0.2.0", 24) ||
      inIpv4(value, "198.51.100.0", 24) ||
      inIpv4(value, "203.0.113.0", 24) ||
      inIpv4(value, "192.88.99.0", 24) ||
      inIpv4(value, "240.0.0.0", 4) ||
      inIpv4(value, "0.0.0.0", 8) ||
      inIpv4(value, "255.255.255.255", 32)
    )
      return "reserved";
    return "public";
  }
  const groups = ipv6Groups(value);
  if (groups.every((part) => part === 0)) return "unspecified";
  if (groups.slice(0, 7).every((part) => part === 0) && groups[7] === 1)
    return "loopback";
  if (ipv6In(value, "fe80::", 10)) return "link-local";
  if ((groups[0]! & 0xff00) === 0xff00) return "multicast";
  if (ipv6In(value, "fc00::", 7)) return "private";
  if (ipv6In(value, "2001:db8::", 32)) return "reserved";
  if (ipv6In(value, "::ffff:0:0", 96)) {
    const mapped = `${groups[6]! >> 8}.${groups[6]! & 255}.${groups[7]! >> 8}.${groups[7]! & 255}`;
    return classifyCanonical(mapped);
  }
  if (
    !ipv6In(value, "2000::", 3) ||
    ipv6In(value, "2001::", 23) ||
    ipv6In(value, "2002::", 16) ||
    ipv6In(value, "3fff::", 20)
  )
    return "reserved";
  return "public";
}
export function classifyAddress(value: string): AddressClass {
  return classifyCanonical(canonicalAddress(value));
}
function checkRawPath(value: string): void {
  const schemeEnd = value.indexOf("://");
  const authorityOffset =
    schemeEnd < 0 ? -1 : value.slice(schemeEnd + 3).search(/[/?#]/u);
  if (authorityOffset < 0) return;
  const path =
    value.slice(schemeEnd + 3 + authorityOffset).split(/[?#]/u, 1)[0] ?? "";
  if (/%(?![0-9a-f]{2})/iu.test(path) || /%(?:2e|2f|5c)/iu.test(path))
    invalid();
  if (/(?:^|\/)\.{1,2}(?:\/|$)/u.test(path)) invalid();
}
function checkRelativePath(value: string): void {
  const path = value.split(/[?#]/u, 1)[0] ?? "";
  if (/%(?![0-9a-f]{2})/iu.test(path) || /%(?:2e|2f|5c)/iu.test(path))
    invalid();
  if (/(?:^|\/)\.{1,2}(?:\/|$)/u.test(path)) invalid();
}
function checkDecodedPath(value: string): void {
  let candidate = value;
  for (let round = 0; round < 4; round += 1) {
    if (/%(?![0-9a-f]{2})/iu.test(candidate)) invalid();
    let decoded: string;
    try {
      decoded = decodeURIComponent(candidate);
    } catch {
      invalid();
    }
    if (
      decoded.includes("\\") ||
      decoded.includes("//") ||
      decoded.split("/").some((part) => part === "." || part === "..") ||
      /[\p{Cc}\p{Cf}]/u.test(decoded)
    )
      invalid();
    if (decoded === candidate) return;
    candidate = decoded;
  }
  if (/%/u.test(candidate)) invalid();
}
function rawAuthorityHost(value: string): string {
  const schemeEnd = value.indexOf("://");
  if (schemeEnd < 0) return "";
  const authority = value.slice(schemeEnd + 3).split(/[/?#]/u, 1)[0] ?? "";
  if (authority.includes("@")) return "";
  if (authority.startsWith("[")) {
    const closing = authority.indexOf("]");
    return closing < 0 ? "" : authority.slice(1, closing);
  }
  const separator = authority.lastIndexOf(":");
  return separator < 0 ? authority : authority.slice(0, separator);
}
function rawAuthorityPort(value: string): string | null {
  const schemeEnd = value.indexOf("://");
  if (schemeEnd < 0) return null;
  const authority = value.slice(schemeEnd + 3).split(/[/?#]/u, 1)[0] ?? "";
  if (authority.includes("@")) return null;
  if (authority.startsWith("[")) {
    const closing = authority.indexOf("]");
    if (closing < 0) return null;
    const suffix = authority.slice(closing + 1);
    if (!suffix) return null;
    return suffix.startsWith(":") ? suffix.slice(1) : "";
  }
  const separator = authority.lastIndexOf(":");
  return separator < 0 ? null : authority.slice(separator + 1);
}
function checkQuery(value: string): void {
  if (/%(?![0-9a-f]{2})/iu.test(value)) invalid();
  for (const pair of value.split("&")) {
    const key = pair.split("=", 1)[0] ?? "";
    let decoded: string;
    let decodedPair: string;
    try {
      decoded = decodeURIComponent(key.replaceAll("+", " "))
        .toLowerCase()
        .replaceAll("-", "_");
      decodedPair = decodeURIComponent(pair.replaceAll("+", " "));
    } catch {
      invalid();
    }
    if (
      /[\p{Cc}\p{Cf}]/u.test(decodedPair) ||
      SENSITIVE_QUERY_KEYS.has(decoded) ||
      SENSITIVE_QUERY_SUFFIXES.some((suffix) => decoded.endsWith(suffix))
    )
      invalid();
  }
}
function normalizeHostname(value: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.endsWith(".") ||
    value.includes("%")
  )
    invalid();
  const ascii = value.toLowerCase();
  if (isIP(ascii) === 4) return canonicalAddress(ascii);
  if (isIP(ascii) === 6) return canonicalAddress(ascii);
  const labels = ascii.split(".");
  if (labels.length > 127 || labels.some((label) => !DNS_LABEL.test(label)))
    invalid();
  if (ascii.length > 253) invalid();
  return ascii;
}
function normalizeOrigin(value: Origin): Origin {
  if (
    typeof value !== "object" ||
    value === null ||
    (value.scheme !== "http" && value.scheme !== "https") ||
    normalizeHostname(value.hostname) !== value.hostname ||
    !Number.isSafeInteger(value.port) ||
    value.port < 1 ||
    value.port > 65535
  )
    invalid();
  return Object.freeze({ ...value });
}
function originText(origin: Origin): string {
  const port =
    DEFAULT_PORT[origin.scheme] === origin.port ? "" : `:${origin.port}`;
  const host = origin.hostname.includes(":")
    ? `[${origin.hostname}]`
    : origin.hostname;
  return `${origin.scheme}://${host}${port}`;
}
function equalOrigin(left: Origin, right: Origin): boolean {
  return (
    left.scheme === right.scheme &&
    left.hostname === right.hostname &&
    left.port === right.port
  );
}
function policyValues(
  policy: DestinationPolicy | undefined,
): Required<DestinationPolicy> {
  if (policy !== undefined && (typeof policy !== "object" || policy === null))
    invalid();
  const schemes = (policy?.allowed_schemes ?? [
    ...DEFAULT_SCHEMES,
  ]) as readonly ("http" | "https")[];
  const classes = policy?.allowed_classes ?? [...DEFAULT_CLASSES];
  if (
    !Array.isArray(schemes) ||
    !Array.isArray(classes) ||
    !Array.isArray(policy?.allowed_addresses ?? []) ||
    !Array.isArray(policy?.allowed_origins ?? []) ||
    schemes.length === 0 ||
    schemes.some((scheme) => scheme !== "http" && scheme !== "https") ||
    classes.length === 0 ||
    classes.some(
      (item) =>
        ![
          "public",
          "private",
          "loopback",
          "link-local",
          "multicast",
          "unspecified",
          "reserved",
        ].includes(item),
    )
  )
    invalid();
  const rawAddresses = policy?.allowed_addresses ?? [];
  const rawOrigins = policy?.allowed_origins ?? [];
  const rawPorts = policy?.allowed_ports;
  const addresses = rawAddresses.map(canonicalAddress);
  const origins = rawOrigins.map(normalizeOrigin);
  const ports =
    rawPorts ??
    schemes.map((scheme: "http" | "https") => ({
      scheme,
      port: DEFAULT_PORT[scheme],
    }));
  if (!Array.isArray(ports)) invalid();
  if (
    ports.some(
      (item) =>
        typeof item !== "object" ||
        item === null ||
        !Number.isSafeInteger(item.port) ||
        item.port < 1 ||
        item.port > 65535 ||
        !schemes.includes(item.scheme),
    )
  )
    invalid();
  if (classes.some((item) => item !== "public") && addresses.length === 0)
    invalid();
  if (
    origins.some(
      (origin) =>
        !schemes.includes(origin.scheme) ||
        !ports.some(
          (item) => item.scheme === origin.scheme && item.port === origin.port,
        ),
    )
  )
    invalid();
  return {
    allowed_schemes: [...new Set(schemes)],
    allowed_classes: [...new Set(classes)],
    allowed_addresses: [...new Set(addresses)],
    allowed_origins: origins,
    allowed_ports: ports,
  };
}
export function normalizeUrl(
  value: string,
  policy?: DestinationPolicy,
): NormalizedUrl {
  if (
    typeof value !== "string" ||
    !value ||
    /\s|[\p{Cc}\p{Cf}]|\\/u.test(value)
  )
    invalid();
  if (!/^https?:\/\/[^/?#]+/iu.test(value) || value.includes("#")) invalid();
  const authorityInput = value
    .slice(value.indexOf("://") + 3)
    .split(/[/?#]/u, 1)[0]!;
  if (authorityInput.includes("@") || authorityInput.includes("%")) invalid();
  checkRawPath(value);
  const values = policyValues(policy);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    invalid();
  }
  const scheme = parsed.protocol.slice(0, -1);
  if (
    (scheme !== "http" && scheme !== "https") ||
    !values.allowed_schemes.includes(scheme)
  )
    invalid();
  if (parsed.username || parsed.password || parsed.hash) invalid();
  checkQuery(parsed.search.slice(1));
  const hostname = normalizeHostname(parsed.hostname.replace(/^\[|\]$/gu, ""));
  if (isIP(hostname)) {
    const rawHost = rawAuthorityHost(value).toLowerCase();
    if (!rawHost || canonicalAddress(rawHost) !== hostname) invalid();
  }
  const port = parsed.port ? Number(parsed.port) : DEFAULT_PORT[scheme];
  const rawPort = rawAuthorityPort(value);
  if (rawPort !== null && rawPort !== String(port)) invalid();
  if (
    !values.allowed_ports.some(
      (item) => item.scheme === scheme && item.port === port,
    )
  )
    invalid();
  const path = parsed.pathname || "/";
  if (
    path.includes("//") ||
    path.split("/").some((part) => part === "." || part === "..")
  )
    invalid();
  if (/%(?:2e|2f|5c)/iu.test(path) || /%(?![0-9a-f]{2})/iu.test(path))
    invalid();
  checkDecodedPath(path);
  const origin = Object.freeze({ scheme, hostname, port });
  const authority = originText(origin);
  const url = `${authority}${path}${parsed.search}`;
  return Object.freeze({
    url,
    scheme,
    hostname,
    port,
    path,
    query: parsed.search.slice(1),
    origin,
  });
}
function permitted(
  destination: ResolvedDestination,
  values: Required<DestinationPolicy>,
): boolean {
  if (values.allowed_addresses.length > 0)
    return destination.addresses.every(
      (address, index) =>
        values.allowed_addresses.includes(address) &&
        values.allowed_classes.includes(destination.classes[index]!),
    );
  return destination.classes.every((item) =>
    values.allowed_classes.includes(item),
  );
}
export async function resolveDestination(
  value: string | NormalizedUrl,
  resolver: Resolver,
  policy?: DestinationPolicy,
  previous?: ResolvedDestination,
): Promise<ResolvedDestination> {
  const values = policyValues(policy);
  const url =
    typeof value === "string"
      ? normalizeUrl(value, values)
      : normalizeUrl(value.url, values);
  let addresses: readonly string[];
  if (isIP(url.hostname)) addresses = [canonicalAddress(url.hostname)];
  else {
    let resolved: readonly string[];
    try {
      resolved = await resolver(url.hostname);
    } catch {
      invalid();
    }
    if (!Array.isArray(resolved) || !resolved.length) invalid();
    addresses = [...new Set(resolved.map(canonicalAddress))].sort();
  }
  const classes = addresses.map(classifyCanonical);
  const destination = Object.freeze({
    url,
    addresses: Object.freeze(addresses),
    classes: Object.freeze(classes),
  });
  if (!permitted(destination, values)) invalid();
  if (
    previous &&
    previous.url.hostname === destination.url.hostname &&
    previous.addresses.join(",") !== destination.addresses.join(",")
  )
    invalid();
  admittedDestinations.add(destination);
  return destination;
}
export async function evaluateRedirect(
  current: ResolvedDestination,
  location: string,
  resolver: Resolver,
  policy?: DestinationPolicy,
  targetGuard?: (target: string) => void,
): Promise<RedirectDecision> {
  assertResolvedDestination(current);
  if (
    !current ||
    typeof location !== "string" ||
    !location ||
    /\s|\\/u.test(location)
  )
    invalid();
  if (!/^[a-z][a-z\d+.-]*:\/\//iu.test(location)) checkRelativePath(location);
  let target: string;
  try {
    target = new URL(location, current.url.url).toString();
    targetGuard?.(target);
  } catch {
    invalid();
  }
  const destination = await resolveDestination(
    target,
    resolver,
    policy,
    current,
  );
  const values = policyValues(policy);
  const same = equalOrigin(current.url.origin, destination.url.origin);
  const forward =
    same ||
    values.allowed_origins.some((origin) =>
      equalOrigin(origin, destination.url.origin),
    );
  return Object.freeze({
    source: current,
    destination,
    same_origin: same,
    forward_credentials: forward,
  });
}
export function bindSocketAddress(
  destination: ResolvedDestination,
): readonly { address: string; port: number; servername: string }[] {
  assertResolvedDestination(destination);
  return Object.freeze(
    destination.addresses.map((address) =>
      Object.freeze({
        address,
        port: destination.url.port,
        servername: destination.url.hostname,
      }),
    ),
  );
}
