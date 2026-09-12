import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli/main.js";
import { TypeScriptConfigurationOwner } from "../src/configuration/owner.js";

async function* input(text: string): AsyncIterable<Uint8Array> {
  yield Buffer.from(text);
}

describe("TypeScript configuration center", () => {
  it("navigates every area offline and renders shared readiness", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-tui-navigation-"));
    const output: string[] = [];
    try {
      const result = await runCli(["config"], {
        home,
        stdin: input("m\ns\nd\np\na\nb\ni\nt\nq\n"),
        stdout: (text) => output.push(text),
      });
      expect(result.code).toBe(0);
      const screen = output.join("");
      for (const area of [
        "Models",
        "Search",
        "Download",
        "Parse",
        "Analyze",
        "Browser",
        "Status",
        "Theme",
        "Quit",
      ])
        expect(screen).toContain(area);
      expect(screen).toContain('"network_performed": false');
      expect(screen).toContain('"browser_launched": false');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("uses local status for non-interactive invocations without creating a catalog", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-tui-status-"));
    try {
      const output: string[] = [];
      const result = await runCli(["config", "status", "--json"], {
        home,
        stdout: (text) => output.push(text),
      });
      expect(result.code).toBe(0);
      expect(result.value).toMatchObject({
        network_performed: false,
        browser_launched: false,
      });
      expect(JSON.parse(output.join(""))).toMatchObject({
        network_performed: false,
        browser_launched: false,
      });
      await expect(
        readFile(join(home, "catalog.sqlite")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("supports local status navigation through the same TS owner", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-tui-theme-"));
    const owner = new TypeScriptConfigurationOwner(home);
    try {
      expect((await owner.status()).network_performed).toBe(false);
      const output: string[] = [];
      await runCli(["config"], {
        home,
        stdin: input("i\nq\n"),
        stdout: (text) => output.push(text),
      });
      expect(output.join("")).toContain("Status");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
