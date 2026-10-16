import { ContractValidationError } from "@sciretriever/contracts";
import type { OrdinaryConfiguration } from "../configuration/index.js";
import {
  TypeScriptConfigurationOwner,
  ConfigurationProbeSession,
  isConfigurationSection,
  isConfigurationProbeOwner,
  renderConfigurationText,
  type ConfigurationProbeSeams,
  type TypeScriptCredentialEdit,
} from "../configuration/owner.js";
import { operationRecord } from "./query-operations.js";

export const CONFIGURATION_OPERATIONS = [
  "read",
  "status",
  "preview",
  "publish",
  "credential",
  "probe",
] as const;
export type ConfigurationOperation = (typeof CONFIGURATION_OPERATIONS)[number];
/** Configuration operations do not initialize the catalog or construct a maintenance Application. */
export async function executeConfiguration(
  owner: TypeScriptConfigurationOwner,
  operation: ConfigurationOperation,
  value: unknown,
  signal?: AbortSignal,
  seams: ConfigurationProbeSeams = {},
): Promise<unknown> {
  if (operation === "read" || operation === "status") {
    operationRecord(value, []);
    return operation === "read" ? owner.read(signal) : owner.status(signal);
  }
  if (operation === "probe") {
    const r = operationRecord(value, ["owner", "target", "image"]);
    if (
      !isConfigurationProbeOwner(r.owner) ||
      (r.target !== null && typeof r.target !== "string") ||
      typeof r.image !== "boolean"
    )
      throw new ContractValidationError();
    const session = await ConfigurationProbeSession.create(owner, seams);
    try {
      return await session.run(
        { owner: r.owner, target: r.target, image: r.image },
        { authorized: true, ...(signal ? { signal } : {}) },
      );
    } finally {
      session.close();
    }
  }
  if (operation === "credential") {
    const r = operationRecord(value, ["edit", "baseline"]);
    if (typeof r.baseline !== "string") throw new ContractValidationError();
    // The owner validates the closed edit union and returns only credential presence.
    const status = await owner.credential(
      r.edit as TypeScriptCredentialEdit,
      r.baseline,
      signal,
    );
    return {
      status,
      credential_effective_at: "next-external-request",
      in_flight_credential_action: "may-complete",
    };
  }
  const r = operationRecord(
    value,
    ["baseline", ...(operation === "publish" ? ["sections"] : [])],
    ["payload", "configuration"],
  );
  if (
    typeof r.baseline !== "string" ||
    Object.hasOwn(r, "payload") === Object.hasOwn(r, "configuration")
  )
    throw new ContractValidationError();
  let payload: unknown = r.payload;
  if (Object.hasOwn(r, "configuration")) {
    const current = await owner.read(signal);
    operationRecord(r.configuration, Object.keys(current.configuration));
    try {
      payload = renderConfigurationText(
        r.configuration as OrdinaryConfiguration,
      );
    } catch {
      throw new ContractValidationError();
    }
  }
  if (typeof payload !== "string") throw new ContractValidationError();
  if (operation === "preview") return owner.diff(payload, r.baseline, signal);
  if (
    !Array.isArray(r.sections) ||
    !r.sections.length ||
    !r.sections.every(isConfigurationSection)
  )
    throw new ContractValidationError();
  const snapshot = await owner.publish(payload, r.baseline, r.sections, signal);
  return {
    snapshot,
    configuration_effective_at: "new-runtime",
    restart_required: true,
  };
}
