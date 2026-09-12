import { describe, expect, it } from "vitest";
import { parseBrowserAction, parseOperatorInput } from "../src/index.js";

describe("closed browser action contracts", () => {
  it("round trips the six Agent actions and rejects unknown properties", () => {
    const actions = [
      { kind: "click-element", element_id: "element-1", revision: 1 },
      { kind: "click-point", x: 1, y: 2, revision: 1, viewport_version: 1 },
      { kind: "scroll-surface", delta_x: 0, delta_y: 200, revision: 1 },
      { kind: "go-back", revision: 1 },
      { kind: "wait-for-change", revision: 1, timeout_ms: 500 },
      { kind: "stop", reason: "user" },
    ];
    for (const action of actions) {
      expect(parseBrowserAction(JSON.parse(JSON.stringify(action)))).toEqual(
        action,
      );
      for (const key of ["selector", "url", "script", "file", "text", "key"])
        expect(() =>
          parseBrowserAction({ ...action, [key]: "untrusted" }),
        ).toThrow();
    }
  });
  it("keeps text and key commands exclusively in the human input contract", () => {
    for (const input of [
      {
        kind: "type-text",
        element_id: "field-1",
        text: "exact input ",
        revision: 1,
      },
      { kind: "press-key", key: "Enter", revision: 1 },
    ]) {
      expect(parseOperatorInput(input)).toEqual(input);
      expect(() => parseBrowserAction(input)).toThrow();
    }
    for (const input of [
      { kind: "press-key", key: "Control+L", revision: 1 },
      {
        kind: "type-text",
        element_id: "field-1",
        text: "x".repeat(4097),
        revision: 1,
      },
      { kind: "upload", path: "/tmp/file", revision: 1 },
    ])
      expect(() => parseOperatorInput(input)).toThrow();
  });
  it("refuses nonfinite coordinates, fractional versions and invalid limits", () => {
    for (const value of [NaN, Infinity, -1])
      expect(() =>
        parseBrowserAction({
          kind: "click-point",
          x: value,
          y: 1,
          revision: 1,
          viewport_version: 1,
        }),
      ).toThrow();
    expect(() =>
      parseBrowserAction({ kind: "go-back", revision: 1.1 }),
    ).toThrow();
    expect(() =>
      parseBrowserAction({
        kind: "scroll-surface",
        delta_x: 0,
        delta_y: 2001,
        revision: 1,
      }),
    ).toThrow();
    expect(() =>
      parseBrowserAction({
        kind: "wait-for-change",
        revision: 1,
        timeout_ms: 120001,
      }),
    ).toThrow();
  });
});
