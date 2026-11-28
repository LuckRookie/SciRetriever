import { expect, it } from "vitest";
import { ARCHIVE_STEPS } from "@sciretriever/contracts";
import {
  archiveStepForced,
  archiveTranslationForced,
} from "../src/archive/input-key.js";

// ADR 0074 section 5: translation comes last, after the original-language layers.
it("runs the steps in the order of ADR 0074, translation last", () => {
  expect(ARCHIVE_STEPS).toEqual([
    "arrange",
    "proofread",
    "render",
    "layers",
    "metadata",
    "references",
    "tags",
    "translate",
  ]);
});

// Spec 9.3 and 10.3: a from_step forces what rests on it, not every later step.
it("forces the steps a from_step's step feeds, and leaves metadata alone after translate or layers", () => {
  // Normal resume forces nothing.
  expect(archiveStepForced("layers", null)).toBe(false);
  expect(archiveStepForced("translate", null)).toBe(false);
  expect(archiveStepForced("metadata", null)).toBe(false);
  expect(archiveTranslationForced(null)).toEqual({
    text: false,
    layers: false,
  });
  // Redoing the layers redoes them and the translate step's layers part only.
  expect(archiveStepForced("layers", "layers")).toBe(true);
  expect(archiveStepForced("translate", "layers")).toBe(true);
  expect(archiveTranslationForced("layers")).toEqual({
    text: false,
    layers: true,
  });
  for (const later of ["metadata", "references", "tags"] as const)
    expect(archiveStepForced(later, "layers")).toBe(false);
  // Redoing the translation: the full text and the layers part, not the layers.
  expect(archiveStepForced("translate", "translate")).toBe(true);
  expect(archiveTranslationForced("translate")).toEqual({
    text: true,
    layers: true,
  });
  expect(archiveStepForced("layers", "translate")).toBe(false);
  for (const later of ["metadata", "references", "tags"] as const)
    expect(archiveStepForced(later, "translate")).toBe(false);
  // An earlier from_step forces every later text step.
  expect(archiveStepForced("render", "proofread")).toBe(true);
  expect(archiveStepForced("metadata", "proofread")).toBe(true);
  expect(archiveStepForced("tags", "metadata")).toBe(true);
  expect(archiveStepForced("arrange", "proofread")).toBe(false);
  // Translation and layers are forced only when named.
  for (const from of [
    "arrange",
    "proofread",
    "render",
    "metadata",
    "tags",
  ] as const) {
    expect(archiveStepForced("translate", from)).toBe(false);
    expect(archiveStepForced("layers", from)).toBe(false);
    expect(archiveTranslationForced(from)).toEqual({
      text: false,
      layers: false,
    });
  }
});
