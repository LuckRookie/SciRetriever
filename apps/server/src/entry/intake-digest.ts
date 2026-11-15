import { createHash } from "node:crypto";
import { canonicalJsonBytes } from "@sciretriever/contracts";

/** Stable input bytes and ID formatting shared by intake entry adapters. */
export function intakeDigest(
  value: unknown,
  format: "sha256" | "uuid" = "sha256",
): string {
  const hash = createHash("sha256")
    .update(canonicalJsonBytes(value))
    .digest("hex");
  return format === "sha256"
    ? hash
    : `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}
