import { expect, it } from "vitest";
import { archiveStepForced } from "../src/archive/input-key.js";

// Spec 9.3 and 10.3: a from_step forces what rests on it, not every later step.
it("forces the steps a from_step's step feeds, and leaves metadata alone after translate or layers", () => {
  // Normal resume forces nothing.
  expect(archiveStepForced("layers", null)).toBe(false);
  expect(archiveStepForced("metadata", null)).toBe(false);
  // Redoing the layers redoes only the layers.
  expect(archiveStepForced("layers", "layers")).toBe(true);
  for (const later of ["metadata", "references", "tags"] as const)
    expect(archiveStepForced(later, "layers")).toBe(false);
  // Redoing the translation: the layers follow by their input key, not by force.
  expect(archiveStepForced("translate", "translate")).toBe(true);
  expect(archiveStepForced("layers", "translate")).toBe(false);
  expect(archiveStepForced("tags", "translate")).toBe(false);
  // An earlier from_step forces every later text step.
  expect(archiveStepForced("render", "proofread")).toBe(true);
  expect(archiveStepForced("metadata", "proofread")).toBe(true);
  expect(archiveStepForced("tags", "metadata")).toBe(true);
  expect(archiveStepForced("arrange", "proofread")).toBe(false);
  // Translation and layers are forced only when named.
  expect(archiveStepForced("translate", "arrange")).toBe(false);
  expect(archiveStepForced("layers", "arrange")).toBe(false);
});
