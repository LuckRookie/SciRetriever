import { existsSync } from "node:fs";
import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseConfiguration } from "../src/configuration/index.js";
import { runDoctor, startupParts } from "../src/entry/doctor.js";

describe("installed runtime doctor", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("reports all local prerequisites without launching a browser or using the network", async () => {
    vi.stubEnv("SCIRETRIEVER_CLOAK_BUNDLE", "");
    const report = await runDoctor({ cloakBundle: null });
    expect(report).toMatchObject({
      schema_version: 1,
      platform: "linux",
      architecture: "x64",
    });
    expect(
      report.checks
        .filter((item) => item.status === "ready")
        .map((item) => item.name),
    ).toEqual(["platform", "flock", "prlimit", "Xvfb", "mupdf"]);
    expect(report.checks.at(-1)).toMatchObject({
      name: "cloakbrowser",
      status: "blocked",
    });
  });

  it("is ready without pdfinfo or pdftotext on PATH", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sciretriever-no-poppler-"));
    try {
      for (const name of ["flock", "prlimit", "Xvfb"]) {
        const found = (process.env.PATH ?? "")
          .split(":")
          .map((part) => join(part, name))
          .find((path) => existsSync(path));
        expect(found, name).toBeDefined();
        // doctor takes regular files only, so copy rather than link.
        await copyFile(found!, join(directory, name));
        await chmod(join(directory, name), 0o755);
      }
      vi.stubEnv("SCIRETRIEVER_CLOAK_BUNDLE", "");
      vi.stubEnv("PATH", directory);
      const report = await runDoctor({ cloakBundle: null });
      expect(
        report.checks
          .filter((item) => item.status === "ready")
          .map((item) => item.name),
      ).toEqual(["platform", "flock", "prlimit", "Xvfb", "mupdf"]);
      expect(
        report.checks.filter((item) => /^pdf(info|totext)$/u.test(item.name)),
      ).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports the bundled MuPDF reader and, when it is missing, what that costs and how to build it", async () => {
    const ready = await runDoctor({ cloakBundle: null });
    expect(ready.checks.find((item) => item.name === "mupdf")).toMatchObject({
      status: "ready",
      detail: expect.stringMatching(/^1\.28\.6 \(\/.+\/bin\/mutool\)$/u),
    });
    const empty = await mkdtemp(join(tmpdir(), "sciretriever-no-mupdf-"));
    try {
      vi.stubEnv("SCIRETRIEVER_MUPDF", empty);
      const missing = await runDoctor({ cloakBundle: null });
      expect(missing.status).toBe("blocked");
      expect(missing.checks.find((item) => item.name === "mupdf")).toEqual({
        name: "mupdf",
        status: "blocked",
        detail:
          "MuPDF bundle is unavailable: 下载的 PDF 不能验收，导入的 PDF 读不出标题、作者和 DOI，也不能解析全文；在仓库目录执行 `pnpm build`",
      });
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it("blocks on the same three parts the Web start refuses without", async () => {
    const empty = await mkdtemp(join(tmpdir(), "sciretriever-no-parts-"));
    try {
      vi.stubEnv("SCIRETRIEVER_MUPDF", empty);
      vi.stubEnv("PATH", empty);
      const [report, parts] = await Promise.all([
        runDoctor({ cloakBundle: null }),
        startupParts(),
      ]);
      expect(report.status).toBe("blocked");
      expect(parts.filter((part) => !part.ready)).toEqual([
        expect.objectContaining({
          name: "flock",
          remedy: "安装系统的 util-linux",
        }),
        expect.objectContaining({
          name: "prlimit",
          remedy: "安装系统的 util-linux",
        }),
        expect.objectContaining({
          name: "mupdf",
          remedy: "在仓库目录执行 `pnpm build`",
        }),
      ]);
      for (const part of parts)
        expect(report.checks.find((item) => item.name === part.name)).toEqual({
          name: part.name,
          status: "blocked",
          detail: part.detail,
        });
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});

it("reports configured and effective Browser capacity without rewriting old values", async () => {
  const browser = parseConfiguration("[browser]\nmax_concurrency = 99").browser;
  const report = await runDoctor({ cloakBundle: null, browser });
  expect(
    report.checks.find((check) => check.name === "browser-capacity"),
  ).toEqual({
    name: "browser-capacity",
    status: "ready",
    detail:
      "configured sessions=99; effective sessions=8; decision workers=2; restriction=runtime-session-cap",
  });
  expect(browser.max_concurrency).toBe(99);
});
