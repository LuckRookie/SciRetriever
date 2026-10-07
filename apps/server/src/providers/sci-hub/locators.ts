import {
  invalid,
  safeLocator,
  type SourceCandidate,
} from "../../acquisition/sources/locators.js";
export function configuredMirrors(
  enabled: boolean,
  custom: readonly string[] = [],
): readonly SourceCandidate[] {
  if (!Array.isArray(custom)) invalid();
  const values = custom.map((value) =>
    safeLocator("configured-mirror", value, "landing"),
  );
  return enabled ? Object.freeze(values) : Object.freeze([]);
}
