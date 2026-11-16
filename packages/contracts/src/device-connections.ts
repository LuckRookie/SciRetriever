import { ContractValidationError, parseUtcTimestamp } from "./index.js";

export const DEVICE_PURPOSES = ["intake", "read", "operate"] as const;
export type DevicePurpose = (typeof DEVICE_PURPOSES)[number];
export type DeviceKind = "extension" | "agent" | null;
export interface DeviceConnection {
  readonly connection_id: string;
  readonly name: string;
  readonly purposes: readonly DevicePurpose[];
  /** Display only; admission depends on purposes, never on kind. */
  readonly kind: DeviceKind;
  readonly created_at: string;
  readonly paired_at: string | null;
  readonly last_used_at: string | null;
  readonly revoked_at: string | null;
}
export interface DevicePairingRequest {
  readonly address: string;
  readonly name: string;
  readonly purposes: readonly DevicePurpose[];
  readonly kind?: DeviceKind;
}
export interface DevicePairingReceipt {
  readonly connection: DeviceConnection;
  readonly expires_at: string;
  readonly connection_code: string;
}
export interface DeviceExchangeReceipt {
  readonly connection: DeviceConnection;
  readonly token: string;
  readonly token_type: "Bearer";
}
export interface DeviceConnectionPage {
  readonly items: readonly DeviceConnection[];
  readonly next_cursor: string | null;
}
export const DEVICE_ERROR_CODES = [
  "device-input-invalid",
  "device-address-mismatch",
  "device-pairing-invalid",
  "device-pairing-expired",
  "device-pairing-used",
  "device-exchange-rate-limited",
  "device-token-invalid",
  "device-revoked",
  "device-purpose-forbidden",
  "device-token-in-url",
  "device-connection-missing",
  "device-artifact-unavailable",
  "device-unavailable",
] as const;
export const DEVICE_PAIRING_TTL_MS = 10 * 60 * 1000;
export const DEVICE_TOKEN_HEADER = "Authorization";
export function deviceRecord(value: unknown, keys: readonly string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== [...keys].sort().join()
  )
    throw new ContractValidationError();
  return value as Record<string, unknown>;
}
export function deviceName(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > 120 ||
    /\p{Cc}/u.test(value) ||
    /(?:srd1_|srp1_|sr-connect1:)/u.test(value)
  )
    throw new ContractValidationError();
  return value.trim();
}
export function devicePurposes(value: unknown): readonly DevicePurpose[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > DEVICE_PURPOSES.length ||
    value.some((p) => !DEVICE_PURPOSES.includes(p)) ||
    new Set(value).size !== value.length
  )
    throw new ContractValidationError();
  return DEVICE_PURPOSES.filter((p) => value.includes(p));
}
export function deviceConnectionId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value)
  )
    throw new ContractValidationError();
  return value;
}
export function deviceKind(value: unknown): DeviceKind {
  if (value !== null && value !== "extension" && value !== "agent")
    throw new ContractValidationError();
  return value;
}
export function parseDeviceConnection(value: unknown): DeviceConnection {
  const r = deviceRecord(value, [
    "connection_id",
    "name",
    "purposes",
    "kind",
    "created_at",
    "paired_at",
    "last_used_at",
    "revoked_at",
  ]);
  return {
    connection_id: deviceConnectionId(r.connection_id),
    name: deviceName(r.name),
    purposes: devicePurposes(r.purposes),
    kind: deviceKind(r.kind),
    created_at: parseUtcTimestamp(r.created_at),
    paired_at: r.paired_at === null ? null : parseUtcTimestamp(r.paired_at),
    last_used_at:
      r.last_used_at === null ? null : parseUtcTimestamp(r.last_used_at),
    revoked_at: r.revoked_at === null ? null : parseUtcTimestamp(r.revoked_at),
  };
}
/** Explicit port, IPv4/localhost HTTP; no forwarded origin or arbitrary URL. */
export function deviceAddress(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^http:\/\/(localhost|(?:\d{1,3}\.){3}\d{1,3}):([1-9]\d{0,4})\/?$/u.test(
      value,
    )
  )
    throw new ContractValidationError();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ContractValidationError();
  }
  const host = url.hostname;
  if (
    host !== "localhost" &&
    (host === "0.0.0.0" || host.split(".").some((v) => Number(v) > 255))
  )
    throw new ContractValidationError();
  if (Number(value.match(/:(\d+)\/?$/u)![1]) > 65535)
    throw new ContractValidationError();
  return `http://${host}:${Number(value.match(/:(\d+)\/?$/u)![1])}`;
}
export function parseDevicePairingRequest(
  value: unknown,
): Required<DevicePairingRequest> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ContractValidationError();
  const r = deviceRecord({ kind: null, ...value }, [
    "address",
    "name",
    "purposes",
    "kind",
  ]);
  return {
    address: deviceAddress(r.address),
    name: deviceName(r.name),
    purposes: devicePurposes(r.purposes),
    kind: deviceKind(r.kind),
  };
}
export function parseDeviceRenameRequest(value: unknown) {
  const r = deviceRecord(value, ["connection_id", "name"]);
  return {
    connection_id: deviceConnectionId(r.connection_id),
    name: deviceName(r.name),
  };
}
/** Ephemeral exchange material. Never include these values in ordinary Web state/audits. */
export function parseDeviceExchangeRequest(value: unknown) {
  const r = deviceRecord(value, ["pairing_code"]);
  if (
    typeof r.pairing_code !== "string" ||
    !/^srp1_[A-Za-z0-9_-]{43}$/u.test(r.pairing_code)
  )
    throw new ContractValidationError();
  return { pairing_code: r.pairing_code };
}
export function parseDeviceConnectionCode(value: unknown) {
  if (typeof value !== "string" || value.length > 512)
    throw new ContractValidationError();
  const match = /^sr-connect1:([^:]+):(srp1_[A-Za-z0-9_-]{43})$/u.exec(value);
  if (!match) throw new ContractValidationError();
  try {
    return {
      address: deviceAddress(decodeURIComponent(match[1]!)),
      pairing_code: match[2]!,
    };
  } catch {
    throw new ContractValidationError();
  }
}
