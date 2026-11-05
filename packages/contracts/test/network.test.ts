import { describe, expect, it } from "vitest";
import {
  normalizeNetworkProxy,
  parseOutboundNetworkConfiguration,
  parseNetworkReadiness,
  parseNetworkEgress,
} from "../src/index.js";

describe("explicit outbound network configuration", () => {
  it("defaults to direct and keeps explicit proxy ports without selecting requesters", () => {
    const empty = parseOutboundNetworkConfiguration();
    expect(empty).toEqual({
      proxy: null,
      via_proxy: {
        sources: [],
        providers: [],
        doi_resolution: false,
        mineru: false,
        browser: false,
      },
    });
    expect(
      parseOutboundNetworkConfiguration({ proxy: "http://LOCALHOST:80" }),
    ).toEqual({ ...empty, proxy: "http://localhost:80" });
    expect(normalizeNetworkProxy("http://[::1]:7890")).toBe(
      "http://[::1]:7890",
    );
    expect(
      parseOutboundNetworkConfiguration({
        proxy: "http://proxy.example:7890",
        via_proxy: {
          sources: ["semantic-scholar"],
          providers: ["my-model"],
          doi_resolution: true,
          mineru: true,
          browser: true,
        },
      }).via_proxy.sources,
    ).toEqual(["semantic-scholar"]);
  });
  it.each([
    "https://proxy.test:7890",
    "socks5://proxy.test:1080",
    "http://proxy.test",
    "http://u:p@proxy.test:80",
    "http://proxy.test:80/",
    "http://proxy.test:80?q=x",
    "http://proxy.test:80#x",
    "http://proxy.test:0",
    "http://proxy.test:65536",
    "http://proxy.test:80\n",
  ])("rejects unsafe proxy address %s", (value) => {
    expect(() => normalizeNetworkProxy(value)).toThrow(
      expect.objectContaining({ code: "network-proxy-invalid" }),
    );
  });
  it("rejects unknown sources, duplicates and selection without an address with stable codes", () => {
    expect(() =>
      parseOutboundNetworkConfiguration({ via_proxy: { browser: true } }),
    ).toThrow(expect.objectContaining({ code: "network-proxy-required" }));
    for (const sources of [["missing-source"], ["crossref", "crossref"]])
      expect(() =>
        parseOutboundNetworkConfiguration({
          proxy: "http://p.test:80",
          via_proxy: { sources },
        }),
      ).toThrow(expect.objectContaining({ code: "network-source-unknown" }));
    expect(() =>
      parseOutboundNetworkConfiguration({
        proxy: "http://p.test:80",
        via_proxy: { providers: ["Uppercase"] },
      }),
    ).toThrow(expect.objectContaining({ code: "network-provider-unknown" }));
    expect(() =>
      parseOutboundNetworkConfiguration({
        proxy: "http://p.test:80",
        via_proxy: { unknown: true },
      }),
    ).toThrow();
  });
  it("exposes only selection and authentication presence in readiness", () => {
    const via_proxy = parseOutboundNetworkConfiguration().via_proxy;
    expect(
      parseNetworkReadiness({
        proxy_configured: false,
        proxy_authentication: false,
        via_proxy,
      }),
    ).toEqual({
      proxy_configured: false,
      proxy_authentication: false,
      via_proxy,
    });
    expect(() =>
      parseNetworkReadiness({
        proxy_configured: false,
        proxy_authentication: true,
        via_proxy,
      }),
    ).toThrow();
    expect(() =>
      parseNetworkReadiness({
        proxy_configured: true,
        proxy_authentication: true,
        via_proxy,
        basic_auth: "fixture:private",
      }),
    ).toThrow();
    expect(parseNetworkEgress("proxy")).toBe("proxy");
    expect(() => parseNetworkEgress("fallback")).toThrow();
  });
});
