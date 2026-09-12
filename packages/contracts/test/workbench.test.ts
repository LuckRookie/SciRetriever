import { describe, expect, it } from "vitest";
import {
  parseWorkbenchActionCommand,
  parseWorkbenchObservation,
} from "../src/index.js";
const binding = {
  session_id: "session-1",
  page_id: "page-1",
  document_generation: 7,
  observation_revision: 3,
  viewport_revision: 2,
  control_epoch: 4,
};
const command = {
  ...binding,
  request_id: "request-1",
  input: {
    kind: "click-point",
    revision: 3,
    viewport_version: 2,
    x: 10,
    y: 10,
  },
};
describe("closed workbench wire contracts", () => {
  it("requires consistent legacy action aliases and rejects injected authority", () => {
    expect(parseWorkbenchActionCommand(command)).toEqual(command);
    for (const invalid of [
      { ...command, role: "operator" },
      { ...command, control_epoch: NaN },
      { ...command, document_generation: 1.1 },
      { ...command, input: { ...command.input, revision: 1 } },
      { ...command, viewport_revision: 1 },
      { ...command, input: { kind: "navigate", url: "https://example.test" } },
    ])
      expect(() => parseWorkbenchActionCommand(invalid)).toThrow();
  });
  it("keeps bytes, query credentials and raw vendor fields out of observation DTOs", () => {
    const observation = {
      ...binding,
      article_id: "article-1",
      frame_seq: 3,
      frame_available: true,
      frame_dropped: false,
      observed_at: "2026-09-10T00:00:00Z",
      url: "http://127.0.0.1/article",
      title: "Fixture",
      text: "Synthetic\ntext",
      loading: false,
      partial: false,
      page_state: "NORMAL",
      capture_state: "NONE",
      viewport: { width: 800, height: 600, device_scale_factor: 1 },
      elements: [],
      remaining: {
        actions: 10,
        bytes: 1000,
        deadline_ms: 1000,
        model_calls: 2,
      },
    };
    expect(parseWorkbenchObservation(observation).document_generation).toBe(7);
    for (const invalid of [
      { ...observation, frame: new Uint8Array([1]) },
      { ...observation, url: "http://127.0.0.1/a?token=private" },
      {
        ...observation,
        viewport: { ...observation.viewport, device_scale_factor: Infinity },
      },
      {
        ...observation,
        elements: [
          {
            element_id: "e1",
            role: "button",
            name: "OK",
            editable: false,
            selector: "#private",
          },
        ],
      },
    ])
      expect(() => parseWorkbenchObservation(invalid)).toThrow();
  });
});
