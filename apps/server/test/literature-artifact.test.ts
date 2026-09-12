import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  readdir,
  stat,
  symlink,
  rename,
  mkdir,
  link,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parseAsset, sha256 } from "@sciretriever/contracts";
import { createApplication } from "../src/bootstrap/application.js";
import { exportArtifact, exportBytes } from "../src/entry/artifact-export.js";
import type {
  LiteratureArtifactService,
  ArtifactReadOptions,
} from "../src/literature/artifacts.js";
const id = "00000000-0000-0000-0000-000000000091";
async function setup() {
  const home = await mkdtemp(join(tmpdir(), "sciretriever-artifact-read-"));
  const app = await createApplication(home);
  const bytes = new Uint8Array(3 * 1024 * 1024 + 7).fill(37);
  const asset = parseAsset({
    asset_id: id,
    sha256: await sha256(bytes),
    size_bytes: bytes.length,
    media_type: "application/octet-stream",
    path: "objects/fixture.bin",
  });
  const stage = await app.files.stage();
  await stage.write(bytes);
  await app.files.publish(stage, asset.path);
  await app.database.putAsset(asset);
  const descriptor = {
    sha256: asset.sha256,
    byte_size: asset.size_bytes,
    media_type: asset.media_type,
  };
  const close = async () => {
    await app.close();
    await rm(home, { recursive: true, force: true });
  };
  return { app, home, bytes, asset, descriptor, close };
}

it("streams only verified catalog artifacts and bounds the stream to its scope, budget and lifetime", async () => {
  const s = await setup();
  try {
    let escaped: AsyncIterable<Uint8Array> | undefined;
    for (const value of [s.asset, s.descriptor]) {
      const result = await s.app.literatureArtifacts.withArtifact(
        value,
        async (chunks) => {
          escaped = chunks;
          const result: Uint8Array[] = [];
          for await (const chunk of chunks) {
            expect(chunk.length).toBeLessThanOrEqual(1024 * 1024);
            result.push(chunk);
          }
          return Buffer.concat(result);
        },
      );
      expect(result.length).toBe(s.bytes.length);
      expect(await sha256(result)).toBe(s.asset.sha256);
    }
    await expect(escaped![Symbol.asyncIterator]().next()).rejects.toMatchObject(
      { code: "verified-artifact-read" },
    );
    await expect(
      s.app.literatureArtifacts.withArtifact(
        { ...s.asset, path: "../escape" },
        async () => null,
      ),
    ).rejects.toThrow();
    await expect(
      s.app.literatureArtifacts.withArtifact(
        { ...s.asset, path: "objects/other.bin" },
        async () => null,
      ),
    ).rejects.toMatchObject({ code: "literature-artifact" });
    await expect(
      s.app.literatureArtifacts.withArtifact(
        { ...s.descriptor, media_type: "application/pdf" },
        async () => null,
      ),
    ).rejects.toMatchObject({ code: "literature-artifact" });
    await expect(
      s.app.literatureArtifacts.withArtifact(s.asset, async () => null, {
        maxBytes: 10,
      }),
    ).rejects.toMatchObject({ code: "verified-artifact-read" });
    const callbackError = new Error("fixture consumer failed");
    await expect(
      s.app.literatureArtifacts.withArtifact(s.asset, async (chunks) => {
        for await (const chunk of chunks) {
          expect(chunk.length).toBeGreaterThan(0);
          throw callbackError;
        }
      }),
    ).rejects.toBe(callbackError);
    const controller = new AbortController();
    await expect(
      s.app.literatureArtifacts.withArtifact(
        s.asset,
        async (chunks) => {
          for await (const chunk of chunks) {
            expect(chunk.length).toBeGreaterThan(0);
            controller.abort();
          }
        },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: "verified-artifact-read" });
    await expect(
      s.app.literatureArtifacts.withArtifact(s.asset, async (chunks) => {
        for await (const chunk of chunks) {
          expect(chunk.length).toBeGreaterThan(0);
          break;
        }
      }),
    ).resolves.toBeUndefined();
    await s.app.literatureArtifacts.withArtifact(s.asset, async (chunks) => {
      for await (const chunk of chunks) chunk.fill(0);
    });
    expect(
      await sha256(await readFile(join(s.app.files.root, s.asset.path))),
    ).toBe(s.asset.sha256);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = s.app.literatureArtifacts.withArtifact(
      s.asset,
      async (chunks) => {
        escaped = chunks;
        enter();
        await gate;
      },
    );
    const rejected = expect(pending).rejects.toMatchObject({
      code: "verified-artifact-read",
    });
    await entered;
    await s.app.files.close();
    await expect(escaped![Symbol.asyncIterator]().next()).rejects.toThrow();
    release();
    await rejected;
  } finally {
    await s.close();
  }
});

it("rejects altered bytes, symlinks and named-object replacement before accepting the read", async () => {
  const s = await setup();
  try {
    const path = join(s.app.files.root, s.asset.path);
    const alias = join(s.home, "hardlink.bin");
    await link(path, alias);
    await expect(
      s.app.literatureArtifacts.withArtifact(s.asset, async () => null),
    ).rejects.toMatchObject({ code: "verified-artifact-read" });
    await rm(alias);
    await writeFile(path, new Uint8Array(s.bytes.length).fill(38));
    let consumed = false;
    await expect(
      s.app.literatureArtifacts.withArtifact(s.asset, async () => {
        consumed = true;
      }),
    ).rejects.toMatchObject({ code: "verified-artifact-read" });
    expect(consumed).toBe(false);
    await writeFile(path, s.bytes);
    await expect(
      s.app.literatureArtifacts.withArtifact(s.asset, async () => {
        await writeFile(path, new Uint8Array(s.bytes.length).fill(39));
      }),
    ).rejects.toMatchObject({ code: "verified-artifact-read" });
    await writeFile(path, s.bytes);
    await expect(
      s.app.literatureArtifacts.withArtifact(s.asset, async () => {
        await rename(
          join(s.app.files.root, "objects"),
          join(s.app.files.root, "renamed"),
        );
        await symlink(
          join(s.app.files.root, "renamed"),
          join(s.app.files.root, "objects"),
        );
      }),
    ).rejects.toMatchObject({ code: "verified-artifact-read" });
    await expect(
      s.app.literatureArtifacts.withArtifact(s.asset, async () => null),
    ).rejects.toMatchObject({ code: "verified-artifact-read" });
  } finally {
    await s.close();
  }
});

it("exports atomically with owner-only permissions, explicit replacement, conflicts and failure cleanup", async () => {
  const s = await setup();
  try {
    const out = join(s.home, "exports");
    await mkdir(out);
    const target = join(out, "result.bin");
    await exportArtifact(s.app.literatureArtifacts, s.descriptor, target);
    expect(await sha256(await readFile(target))).toBe(s.asset.sha256);
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    await writeFile(target, "existing user bytes");
    await expect(
      exportArtifact(s.app.literatureArtifacts, s.asset, target),
    ).rejects.toMatchObject({ code: "artifact-export", published: false });
    expect(await readFile(target, "utf8")).toBe("existing user bytes");
    await exportArtifact(s.app.literatureArtifacts, s.asset, target, {
      overwrite: true,
    });
    expect(await sha256(await readFile(target))).toBe(s.asset.sha256);
    const controller = new AbortController();
    const interrupted: Pick<LiteratureArtifactService, "withArtifact"> = {
      withArtifact<T>(
        value: unknown,
        consume: (chunks: AsyncIterable<Uint8Array>) => Promise<T>,
        options: ArtifactReadOptions = {},
      ): Promise<T> {
        return s.app.literatureArtifacts.withArtifact(
          value,
          (chunks) =>
            consume({
              async *[Symbol.asyncIterator]() {
                for await (const chunk of chunks) {
                  yield chunk;
                  controller.abort();
                }
              },
            }),
          options,
        );
      },
    };
    await expect(
      exportArtifact(interrupted, s.asset, target, {
        overwrite: true,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "artifact-export", published: false });
    expect(await sha256(await readFile(target))).toBe(s.asset.sha256);
    const raced = join(out, "race.bin");
    const results = await Promise.allSettled([
      exportArtifact(s.app.literatureArtifacts, s.asset, raced),
      exportArtifact(s.app.literatureArtifacts, s.asset, raced),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await sha256(await readFile(raced))).toBe(s.asset.sha256);
    await expect(
      exportArtifact(
        s.app.literatureArtifacts,
        s.asset,
        join(out, "cancelled.bin"),
        { signal: AbortSignal.abort() },
      ),
    ).rejects.toMatchObject({ code: "artifact-export", published: false });
    await symlink(out, join(s.home, "linked-output"));
    await expect(
      exportArtifact(
        s.app.literatureArtifacts,
        s.asset,
        join(s.home, "linked-output", "escape.bin"),
      ),
    ).rejects.toMatchObject({ code: "artifact-export", published: false });
    await writeFile(join(s.app.files.root, s.asset.path), "damaged source");
    await expect(
      exportArtifact(s.app.literatureArtifacts, s.asset, target, {
        overwrite: true,
      }),
    ).rejects.toMatchObject({ code: "artifact-export", published: false });
    expect(await sha256(await readFile(target))).toBe(s.asset.sha256);
    expect((await readdir(out)).sort()).toEqual(["race.bin", "result.bin"]);
  } finally {
    await s.close();
  }
});

it("publishes external bibliography bytes atomically without clobbering by default", async () => {
  const s = await setup();
  try {
    const out = join(s.home, "exports-bytes");
    await mkdir(out);
    const target = join(out, "records.json");
    const bytes = new TextEncoder().encode('{"id":"fixture"}\n');
    await exportBytes(bytes, target);
    expect(await readFile(target, "utf8")).toBe('{"id":"fixture"}\n');
    await expect(
      exportBytes(new TextEncoder().encode("changed"), target),
    ).rejects.toMatchObject({
      code: "artifact-export",
      published: false,
    });
    expect(await readFile(target, "utf8")).toBe('{"id":"fixture"}\n');
    await exportBytes(new TextEncoder().encode("changed"), target, {
      overwrite: true,
    });
    expect(await readFile(target, "utf8")).toBe("changed");
  } finally {
    await s.close();
  }
});
