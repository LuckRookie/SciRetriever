import { parseIntakeBatchId } from "@sciretriever/contracts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CitationDiscoveryService,
  TopicDiscoveryService,
} from "../src/entry/discovery.js";
import { TypeScriptConfigurationOwner } from "../src/configuration/owner.js";
import { runCli } from "../src/cli/main.js";

describe("effective metadata source configuration", () => {
  it("uses the saved per-source limit for topic and citation discovery", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-source-limit-"));
    const owner = new TypeScriptConfigurationOwner(home);
    const topic = vi
      .spyOn(TopicDiscoveryService.prototype, "run")
      .mockResolvedValue({
        intake_batch_id: parseIntakeBatchId(
          "00000000-0000-0000-0000-000000001008",
        ),
        discovery_run_id: "00000000-0000-0000-0000-000000000001",
        status: "COMPLETED",
        accepted_count: 0,
        matched_count: 0,
        source_results: [],
      });
    const citations = vi
      .spyOn(CitationDiscoveryService.prototype, "run")
      .mockResolvedValue({
        intake_batch_id: parseIntakeBatchId(
          "00000000-0000-0000-0000-000000001008",
        ),
        discovery_run_id: "00000000-0000-0000-0000-000000000002",
        status: "COMPLETED",
        result_count: 0,
        source_results: [],
      });
    try {
      await owner.publish(
        '[sources.metadata]\nmode = "custom"\nproviders = ["openalex"]\nlimit = 7\n',
        "missing",
        ["sources"],
      );

      await runCli(["discover", "topic", "--text", "synthetic query"], {
        home,
      });
      await runCli(
        [
          "discover",
          "citations",
          "--seed-literature-id",
          "00000000-0000-0000-0000-000000000003",
        ],
        { home },
      );
      await runCli(
        ["discover", "topic", "--text", "synthetic query", "--scan-limit", "3"],
        { home },
      );

      expect(topic.mock.calls[0]![0].providers).toEqual([
        { provider_name: "openalex", scan_limit: 7 },
      ]);
      expect(citations.mock.calls[0]![0].providers).toEqual([
        { provider_name: "openalex", scan_limit: 7 },
      ]);
      expect(topic.mock.calls[1]![0].providers).toEqual([
        { provider_name: "openalex", scan_limit: 3 },
      ]);
    } finally {
      topic.mockRestore();
      citations.mockRestore();
      await rm(home, { recursive: true, force: true });
    }
  });
});
