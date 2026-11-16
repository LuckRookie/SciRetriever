import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  DEVICE_PAIRING_TTL_MS,
  deviceConnectionId,
  deviceName,
  deviceRecord,
  parseDeviceExchangeRequest,
  parseDevicePairingRequest,
  parseDeviceRenameRequest,
  type DeviceConnection,
  type DevicePurpose,
} from "@sciretriever/contracts";
import type { SqliteWorker } from "../storage/sqlite/worker.js";
import type { DeviceStorageCommand } from "../storage/sqlite/device-connection-engine.js";

export class DeviceConnectionError extends Error {
  constructor(readonly code: string) {
    super("Device connection request rejected");
  }
}
export const deviceDigest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function requireDevicePurpose(
  connection: DeviceConnection,
  purposes: readonly DevicePurpose[] | "any",
) {
  if (
    purposes !== "any" &&
    !purposes.some((p) => connection.purposes.includes(p))
  )
    throw new DeviceConnectionError("device-purpose-forbidden");
}
/** Authentication owner; never use generic operation/audit wrappers for secrets. */
export class DeviceConnectionService {
  private readonly revokedListeners = new Set<(connectionId: string) => void>();
  onRevoked(listener: (connectionId: string) => void) {
    this.revokedListeners.add(listener);
    return () => {
      this.revokedListeners.delete(listener);
    };
  }
  constructor(
    private readonly db: SqliteWorker,
    private readonly now: () => number = Date.now,
  ) {}
  private async store<T>(command: DeviceStorageCommand): Promise<T> {
    const reply = await this.db.run<T & { code?: string }>({
      kind: "device_connections",
      command,
    });
    if (reply.code) throw new DeviceConnectionError(reply.code);
    return reply;
  }
  async create(value: unknown) {
    const r = parseDevicePairingRequest(value),
      now = this.now();
    // Prevent accidentally pasting issued material into visible connection names.
    deviceName(r.name);
    const pairing = "srp1_" + randomBytes(32).toString("base64url");
    const connection: DeviceConnection = {
      connection_id: randomUUID(),
      name: r.name,
      purposes: r.purposes,
      kind: r.kind,
      created_at: new Date(now).toISOString(),
      paired_at: null,
      last_used_at: null,
      revoked_at: null,
    };
    const expires_at = new Date(now + DEVICE_PAIRING_TTL_MS).toISOString();
    await this.store({
      kind: "create",
      connection,
      code_sha256: deviceDigest(pairing),
      expires_at,
    });
    return {
      connection,
      expires_at,
      connection_code: `sr-connect1:${encodeURIComponent(r.address)}:${pairing}`,
    };
  }
  async exchange(value: unknown, peer: string) {
    // Malformed attempts also consume the persistent, process-shared allowance.
    let pairing = "";
    try {
      pairing = parseDeviceExchangeRequest(value).pairing_code;
    } catch {
      /* uniform counted rejection */
    }
    const token = "srd1_" + randomBytes(32).toString("base64url");
    const reply = await this.store<{ connection: DeviceConnection }>({
      kind: "exchange",
      code_sha256: deviceDigest(pairing),
      token_sha256: deviceDigest(token),
      peer_sha256: deviceDigest(peer),
      now: new Date(this.now()).toISOString(),
    });
    return { ...reply, token, token_type: "Bearer" as const };
  }
  authenticate(token: string) {
    if (!/^srd1_[A-Za-z0-9_-]{43}$/u.test(token))
      throw new DeviceConnectionError("device-token-invalid");
    return this.store<{ connection: DeviceConnection }>({
      kind: "authenticate",
      token_sha256: deviceDigest(token),
      now: new Date(this.now()).toISOString(),
    });
  }
  /** Revalidate an already authenticated transport binding; never an HTTP authentication substitute. */
  requireActive(connectionId: string) {
    return this.store<{ connection: DeviceConnection }>({
      kind: "check",
      connection_id: deviceConnectionId(connectionId),
    });
  }
  list(value: unknown) {
    const r = deviceRecord(value, ["cursor"]);
    return this.store<{
      items: DeviceConnection[];
      next_cursor: string | null;
    }>({
      kind: "list",
      after: r.cursor === null ? null : deviceConnectionId(r.cursor),
    });
  }
  rename(value: unknown) {
    return this.store<{ connection: DeviceConnection }>({
      kind: "rename",
      ...parseDeviceRenameRequest(value),
    });
  }
  async revoke(value: unknown) {
    const r = deviceRecord(value, ["connection_id"]);
    const result = await this.store<{ connection: DeviceConnection }>({
      kind: "revoke",
      connection_id: deviceConnectionId(r.connection_id),
      now: new Date(this.now()).toISOString(),
    });
    for (const listener of this.revokedListeners)
      listener(result.connection.connection_id);
    return result;
  }
}
