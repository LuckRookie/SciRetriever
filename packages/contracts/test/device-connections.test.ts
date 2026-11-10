import { expect, it } from "vitest";
import {
  deviceAddress,
  parseDeviceConnectionCode,
  parseDevicePairingRequest,
  parseDeviceExchangeRequest,
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
      purposes: ["read", "import"],
    }),
  ).toMatchObject({ name: "desktop", purposes: ["import", "read"] });
  for (const purposes of [[], ["admin"], ["read", "read"], "read"])
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
