import { describe, expect, it } from "vitest";
import {
  ContractValidationError,
  decodeScreencastFrame,
  encodeScreencastFrame,
  parseDirectBrowserInput,
  parseScreencastClientMessage,
  parseScreencastServerMessage,
  type ScreencastFrame,
} from "../src/index.js";
const document = {
  session_id: "session-1",
  article_id: "article-1",
  page_id: "page-1",
  document_generation: 1,
  document_id: "loader-1",
};
const frame: ScreencastFrame = {
  ...document,
  protocol_version: 1,
  subscription_id: "subscription-1",
  frame_id: 1,
  stream_epoch: 1,
  captured_at: "2026-10-28T00:00:00.000Z",
  width: 1280,
  height: 720,
  viewport_width: 1280,
  viewport_height: 720,
  offset_top: 0,
  page_scale_factor: 1,
  device_scale_factor: 1,
  scroll_x: 0,
  scroll_y: 0,
  format: "jpeg",
  quality: 60,
};
const mouse = {
  kind: "mouse",
  action: "down",
  x: 12,
  y: 25,
  button: "left",
  buttons: 1,
  click_count: 1,
  modifiers: 0,
};
describe("authenticated screencast wire protocol", () => {
  it("round trips the exact binary frame envelope and its document/scale facts", () => {
    const jpeg = new Uint8Array([255, 216, 3, 4, 255, 217]);
    const bytes = encodeScreencastFrame(frame, jpeg),
      decoded = decodeScreencastFrame(bytes);
    expect(decoded).toEqual({ frame, jpeg });
    for (const change of [
      (b: Uint8Array) => (b[0] = 0),
      (b: Uint8Array) => (b[15] = 1),
      (b: Uint8Array) => (b[b.length - 1] = 0),
    ]) {
      const b = bytes.slice();
      change(b);
      expect(() => decodeScreencastFrame(b)).toThrow(ContractValidationError);
    }
    expect(() =>
      decodeScreencastFrame(bytes.subarray(0, bytes.length - 1)),
    ).toThrow();
    expect(() =>
      encodeScreencastFrame({ ...frame, quality: NaN }, jpeg),
    ).toThrow();
    expect(() =>
      encodeScreencastFrame(
        { ...frame, document_id: "https://invalid.test/?secret=value" },
        jpeg,
      ),
    ).toThrow();
  });
  it("binds the first meaningful input to a document and rejects observation revisions", () => {
    const input = {
      type: "input",
      subscription_id: frame.subscription_id,
      frame_id: 1,
      seq: 1,
      control_epoch: 0,
      first: true,
      document,
      input: mouse,
    };
    expect(parseScreencastClientMessage(input)).toEqual(input);
    const { document: firstDocument, ...direct } = input;
    expect(firstDocument).toEqual(document);
    expect(parseScreencastClientMessage({ ...direct, first: false })).toEqual({
      ...direct,
      first: false,
    });
    for (const bad of [
      { ...input, observation_revision: 1 },
      { ...direct },
      { ...input, first: false },
      { ...input, input: { ...mouse, action: "move" } },
      { ...input, document: { ...document, page_id: "wrong/page" } },
      { ...input, seq: 0 },
    ])
      expect(() => parseScreencastClientMessage(bad)).toThrow();
  });
  it.each([
    {
      kind: "mouse",
      action: "move",
      x: 5,
      y: 6,
      button: "none",
      buttons: 0,
      click_count: 0,
      modifiers: 0,
    },
    { kind: "drag", phase: "start", x: 1, y: 2, modifiers: 0 },
    { kind: "wheel", x: 5, y: 5, delta_x: 0, delta_y: -120, modifiers: 0 },
    {
      kind: "key",
      action: "down",
      key: "Enter",
      code: "Enter",
      key_code: 13,
      location: 0,
      auto_repeat: false,
      modifiers: 0,
    },
    { kind: "text", text: "中文" },
    { kind: "paste", text: "plain text" },
    { kind: "composition", text: "中文", selection_start: 0, selection_end: 2 },
  ])("accepts bounded direct input %j", (input) =>
    expect(parseDirectBrowserInput(input)).toEqual(input),
  );
  it.each([
    { ...mouse, x: Infinity },
    { kind: "wheel", x: 1, y: 1, delta_x: 0, delta_y: 2001, modifiers: 0 },
    { ...mouse, button: "none" },
    { ...mouse, buttons: 8 },
    { kind: "paste", text: "x".repeat(8193) },
    { kind: "composition", text: "中", selection_start: 0, selection_end: 2 },
    { kind: "text", text: "x", url: "http://invalid" },
  ])("rejects malformed input %j", (input) =>
    expect(() => parseDirectBrowserInput(input)).toThrow(),
  );
  it("parses control/reconnect/no-frame states with technical errors only", () => {
    for (const status of [
      "connecting",
      "live",
      "no-frame",
      "reconnecting",
      "closed",
    ])
      for (const control of [
        "watching",
        "controlling",
        "returning",
        "taken-over",
      ]) {
        const state = {
          type: "state",
          subscription_id: "sub-1",
          session_id: "session-1",
          status,
          control,
          control_epoch: 2,
          stream_epoch: 1,
          agent_paused: control !== "watching",
          problem: null,
        };
        expect(parseScreencastServerMessage(state)).toEqual(state);
        expect(
          parseScreencastServerMessage({ ...state, page_kind: "html" }),
        ).toEqual({ ...state, page_kind: "html" });
        expect(() =>
          parseScreencastServerMessage({
            ...state,
            page_kind: "private-page-text",
          }),
        ).toThrow();
      }
    expect(() =>
      parseScreencastServerMessage({
        type: "input-result",
        seq: 1,
        status: "applied",
        control_epoch: 1,
        problem: { display: "error", technical_details: { diagnostics: [] } },
      }),
    ).toThrow();
    expect(
      parseScreencastClientMessage({
        type: "hello",
        protocol_version: 1,
        client_id: "client-1",
        csrf: "a".repeat(64),
      }),
    ).toMatchObject({ type: "hello" });
    expect(() =>
      parseScreencastClientMessage({
        type: "hello",
        protocol_version: 2,
        client_id: "client-1",
        csrf: "a",
      }),
    ).toThrow();
  });
});
