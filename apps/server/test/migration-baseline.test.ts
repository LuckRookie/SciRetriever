import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

async function json<T>(relativePath: string): Promise<T> {
  return JSON.parse(await readFile(resolve(relativePath), "utf8")) as T;
}

describe("full TypeScript migration baseline", () => {
  it("keeps every active source mapped to a typed owner and evidence", async () => {
    const inventory = await json<{
      modules: readonly {
        source: string;
        disposition: string;
        target: string;
        task_ids: readonly string[];
        consumers: readonly string[];
        mapping: Record<string, string>;
      }[];
      direct_tests: readonly {
        source: string;
        task_ids: readonly string[];
        mapping_reason: string;
      }[];
      counts: Record<string, number>;
      unresolved: readonly unknown[];
    }>("migration/inventory.json");
    expect(inventory.unresolved).toEqual([]);
    expect(inventory.modules).toHaveLength(242);
    expect(inventory.direct_tests).toHaveLength(161);
    for (const module of inventory.modules) {
      expect([
        "port",
        "redesign",
        "retire-approved",
        "historical-nonruntime",
      ]).toContain(module.disposition);
      expect(module.target).toMatch(/^(apps\/server\/src|packages)\//u);
      expect(module.task_ids.length).toBeGreaterThan(0);
      expect(module.consumers.length).toBeGreaterThan(0);
      expect(module.mapping.consumer_source).toBeTruthy();
    }
    for (const test of inventory.direct_tests) {
      expect(test.source).toMatch(/^tests\//u);
      expect(test.task_ids.length).toBeGreaterThan(0);
      expect(test.mapping_reason).toBeTruthy();
    }
  });

  it("records M0 choices without claiming unverified platforms or external access", async () => {
    const runtime = await json<{
      toolchain: { node: { version: string }; playwright: { version: string } };
      platforms: readonly {
        platform: string;
        status: string;
        support?: string;
      }[];
      verification: { external_network: string; user_state: string };
    }>("migration/runtime-matrix.json");
    const release = await json<{
      default_ci: { real_site: string; user_catalog_or_profile: string };
      platforms: readonly {
        platform: string;
        status: string;
        claim?: string;
      }[];
    }>("migration/release-matrix.json");
    expect(runtime.toolchain.node.version).toBe("22.19.0");
    expect(runtime.toolchain.playwright.version).toBe("1.55.0");
    expect(runtime.verification).toMatchObject({
      external_network: "not-authorized",
      user_state: "not-read",
    });
    expect(release.default_ci.real_site).toBe("not-run");
    expect(release.default_ci.user_catalog_or_profile).toBe("not-read");
    expect(
      runtime.platforms.find((item) => item.platform === "darwin")?.status,
    ).toBe("not-verified");
    expect(
      release.platforms.find((item) => item.platform === "win32")?.claim,
    ).toBe("none");
  });

  it("keeps the synthetic v1 oracle hashes immutable", async () => {
    const oracle = await json<{
      synthetic_only: boolean;
      fixture_manifest: string;
      canonical_encoding: { sort_keys: boolean; ensure_ascii: boolean };
      sha256_by_record: Record<string, string>;
    }>("migration/oracle-manifest.json");
    expect(oracle.synthetic_only).toBe(true);
    expect(oracle.fixture_manifest).toBe(
      "tests/fixtures/compat-v1/manifest.json",
    );
    expect(oracle.canonical_encoding).toMatchObject({
      sort_keys: true,
      ensure_ascii: false,
    });
    expect(Object.keys(oracle.sha256_by_record)).toEqual([
      "provenance",
      "metadata",
      "query",
      "asset",
      "relation",
      "literature",
      "canonical_parameters",
    ]);
    for (const digest of Object.values(oracle.sha256_by_record))
      expect(digest).toMatch(/^[0-9a-f]{64}$/u);
  });
});
