import {
  lstat,
  mkdtemp,
  readFile,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigurationBoundaryError,
  loadConfiguration,
  publishConfiguration,
} from "../src/configuration/index.js";

const config = '[paths]\ncatalog_path = "catalog.sqlite"\n';

describe("configuration publication", () => {
  it("publishes with expected fingerprint and preserves concurrent edits", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-config-"));
    const first = new TextEncoder().encode(config);
    const fingerprint = await publishConfiguration(home, first, null);
    await expect(loadConfiguration(home)).resolves.toBeDefined();
    await expect(
      publishConfiguration(
        home,
        new TextEncoder().encode("[paths]\n"),
        "0".repeat(64),
      ),
    ).rejects.toBeInstanceOf(ConfigurationBoundaryError);
    await expect(
      readFile(join(home, ".sciretriever", "config.toml")),
    ).resolves.toEqual(Buffer.from(first));
    expect(fingerprint).toHaveLength(64);
  });

  it("rejects symlink targets and does not replace their referent", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-config-"));
    const outside = await mkdtemp(
      join(tmpdir(), "sciretriever-config-outside-"),
    );
    await publishConfiguration(home, new TextEncoder().encode(config), null);
    const target = join(home, ".sciretriever", "config.toml");
    const outsideFile = join(outside, "config.toml");
    await writeFile(outsideFile, "outside");
    await unlink(target);
    await symlink(outsideFile, target);
    await expect(
      publishConfiguration(home, new TextEncoder().encode(config), null),
    ).rejects.toBeInstanceOf(ConfigurationBoundaryError);
    await expect(lstat(target)).resolves.toMatchObject({
      isSymbolicLink: expect.any(Function),
    });
    await expect(readFile(outsideFile, "utf8")).resolves.toBe("outside");
  });

  it("serializes first publication so concurrent creators cannot overwrite one another", async () => {
    const home = await mkdtemp(join(tmpdir(), "sciretriever-config-"));
    const first = new TextEncoder().encode(config);
    const second = new TextEncoder().encode(
      '[paths]\ncatalog_path = "other.sqlite"\n',
    );
    const results = await Promise.allSettled([
      publishConfiguration(home, first, null),
      publishConfiguration(home, second, null),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const stored = await readFile(
      join(home, ".sciretriever", "config.toml"),
      "utf8",
    );
    expect([config, '[paths]\ncatalog_path = "other.sqlite"\n']).toContain(
      stored,
    );
  });
});
