import { expect, it } from "vitest";
import {
  deviceAddress,
  parseDeviceConnectionCode,
  parseDevicePairingRequest,
  parseDeviceExchangeRequest,
  parseDeviceConnection,
} from "../src/index.js";
it("keeps connection codes versioned and accepts only explicit IPv4/localhost HTTP addresses and closed purposes", () => {
  for (const address of ["http://localhost:4174", "http://127.0.0.1:80"]) {
    expect(deviceAddress(address)).toBe(address);
    const code =
      "sr-connect1:" + encodeURIComponent(address) + ":srp1_" + "a".repeat(43);
    expect(parseDeviceConnectionCode(code).address).toBe(address);
  }
  for (const address of [
    "https://localhost:4174",
    "http://localhost",
    "http://example.com:4174",
    "http://localhost:0",
    "http://localhost:65536",
    "http://127.0.0.1:4174/a",
    "http://127.0.0.1:4174/?token=x",
    "http://user:pass@127.0.0.1:4174",
    "http://0.0.0.0:4174",
    "http://999.1.1.1:4174",
  ])
    expect(() => deviceAddress(address)).toThrow();
  expect(
    parseDevicePairingRequest({
      address: "http://localhost:4174",
      name: " desktop ",
      purposes: ["read", "intake"],
    }),
  ).toMatchObject({ name: "desktop", purposes: ["intake", "read"] });
  for (const purposes of [
    [],
    ["admin"],
    ["capture"],
    ["import"],
    ["read", "read"],
    "read",
  ])
    expect(() =>
      parseDevicePairingRequest({
        address: "http://localhost:4174",
        name: "desktop",
        purposes,
      }),
    ).toThrow();
  expect(() =>
    parseDeviceExchangeRequest({
      pairing_code: "srp1_" + "a".repeat(43),
      token: "extra",
    }),
  ).toThrow();
  expect(() => parseDeviceConnectionCode("sr-connect2:invalid")).toThrow();
});

it("normalizes omitted connection kinds to null and strictly parses display-only kinds", () => {
  const request = {
    address: "http://localhost:4174",
    name: "Synthetic",
    purposes: ["read"],
  };
  expect(parseDevicePairingRequest(request)).toEqual({
    ...request,
    kind: null,
  });
  const connection = {
    connection_id: "00000000-0000-0000-0000-000000000001",
    name: "Synthetic",
    purposes: ["read"],
    kind: null,
    created_at: "2026-11-17T00:00:00.000Z",
    paired_at: null,
    last_used_at: null,
    revoked_at: null,
  };
  for (const kind of [null, "extension", "agent"] as const) {
    expect(parseDevicePairingRequest({ ...request, kind })).toEqual({
      ...request,
      kind,
    });
    expect(parseDeviceConnection({ ...connection, kind })).toEqual({
      ...connection,
      kind,
    });
  }
  for (const kind of [undefined, "browser", "", 0, false, {}, []]) {
    expect(() => parseDevicePairingRequest({ ...request, kind })).toThrow();
    expect(() => parseDeviceConnection({ ...connection, kind })).toThrow();
  }
  const { kind, ...withoutKind } = connection;
  void kind;
  expect(() => parseDeviceConnection(withoutKind)).toThrow();
  expect(() =>
    parseDevicePairingRequest({ ...request, unknown: true }),
  ).toThrow();
  expect(() =>
    parseDeviceConnection({ ...connection, unknown: true }),
  ).toThrow();
});
