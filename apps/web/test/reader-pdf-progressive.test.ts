/**
 * Opening a PDF by ranges (reading-experience 5.1, 6.3, 8.2; ADR 0065
 * section 6 rule 6): the first page shows before the whole file is in, the
 * whole SHA-256 is checked once in the background, and a failed check
 * replaces the page with “文件与记录不一致”. Numbers go to a JSON report
 * (SCIRETRIEVER_PDF_REPORT_DIR, else a temporary directory).
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import type { CDPSession, Page } from "playwright";
import { expect, it } from "vitest";
import { parseLiterature } from "@sciretriever/contracts";
import { FIXTURE_LITERATURE } from "../../server/src/workbench/synthetic-fixture.js";
import { nextWorkspace } from "./next-workspace-fixture.js";
import { missingId } from "./processor-workspace-fixture.js";

type Workspace = Awaited<ReturnType<typeof nextWorkspace>>;

/**
 * A text PDF whose every page carries `padding` bytes in its content stream.
 * "grouped": the page dictionaries come first, as many producers write them;
 * "interleaved": each sits before its content, the worst case for PDF.js,
 * which reads every top-level page dictionary before showing page 1.
 */
function paddedPdf(
  pages: number,
  padding: number,
  layout: "grouped" | "interleaved" = "grouped",
) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const kids: number[] = [];
  const filler = `% ${"x".repeat(1022)}\n`;
  const page = (n: number) => 3 + (layout === "grouped" ? n : 2 * n - 1);
  const content = (n: number) =>
    layout === "grouped" ? 3 + pages + n : page(n) + 1;
  for (let n = 1; n <= pages; n++) {
    kids.push(page(n));
    const text =
      `BT /F1 20 Tf 60 740 Td (Large synthetic paper - page ${n}) Tj ET\n` +
      filler.repeat(Math.ceil(padding / filler.length));
    objects[page(n) - 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${content(n)} 0 R >>`;
    objects[content(n) - 1] =
      `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`;
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${pages} >>`;
  const parts: string[] = ["%PDF-1.4\n"];
  let at = parts[0]!.length;
  const offsets: number[] = [];
  objects.forEach((object, i) => {
    offsets.push(at);
    const text = `${i + 1} 0 obj\n${object}\nendobj\n`;
    parts.push(text);
    at += Buffer.byteLength(text);
  });
  parts.push(
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
      .map((n) => String(n).padStart(10, "0") + " 00000 n \n")
      .join(
        "",
      )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF`,
  );
  return Buffer.from(parts.join(""));
}

interface Request {
  url: string;
  clientId: string | null;
  range: string | null;
  cacheControl: string | null;
  status: number;
  cached: boolean;
  bytes: number;
  done: boolean;
}
/** Material byte requests as Chromium saw them, cache hits included. */
async function watchNetwork(page: Page) {
  const cdp: CDPSession = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  let list = new Map<string, Request>();
  const all = new Map<string, Request>();
  cdp.on("Network.requestWillBeSent", (event) => {
    if (!new URL(event.request.url).pathname.includes("/query/material-bytes"))
      return;
    const headers = event.request.headers as Record<string, string>;
    const request: Request = {
      url: event.request.url,
      clientId:
        headers["X-Sciretriever-Client-Id"] ??
        headers["x-sciretriever-client-id"] ??
        null,
      range: headers.Range ?? headers.range ?? null,
      cacheControl: null,
      status: 0,
      cached: false,
      bytes: 0,
      done: false,
    };
    if (sent.has(event.requestId))
      request.cacheControl = sent.get(event.requestId)!;
    list.set(event.requestId, request);
    all.set(event.requestId, request);
  });
  // The headers as sent; this event may come before or after the request's.
  const sent = new Map<string, string | null>();
  cdp.on("Network.requestWillBeSentExtraInfo", (event) => {
    const headers = event.headers as Record<string, string>;
    const value = headers["Cache-Control"] ?? headers["cache-control"] ?? null;
    sent.set(event.requestId, value);
    const request = all.get(event.requestId);
    if (request) request.cacheControl = value;
  });
  cdp.on("Network.requestServedFromCache", (event) => {
    const request = all.get(event.requestId);
    if (request) request.cached = true;
  });
  cdp.on("Network.responseReceived", (event) => {
    const request = all.get(event.requestId);
    if (!request) return;
    request.status = event.response.status;
    if (event.response.fromDiskCache) request.cached = true;
  });
  cdp.on("Network.dataReceived", (event) => {
    const request = all.get(event.requestId);
    if (request) request.bytes += event.dataLength;
  });
  for (const name of ["Network.loadingFinished", "Network.loadingFailed"])
    cdp.on(name as "Network.loadingFinished", (event) => {
      const request = all.get(event.requestId);
      if (request) request.done = true;
    });
  return {
    cdp,
    take() {
      const taken = [...list.values()];
      list = new Map();
      return taken;
    },
    pending: () => [...all.values()].some((r) => !r.done),
  };
}
type Network = Awaited<ReturnType<typeof watchNetwork>>;

/** The first drawn PDF page, in ms since navigation start (`__firstPage`). */
async function markFirstPage(page: Page) {
  await page.addInitScript(() => {
    const scope = window as unknown as { __firstPage: number | null };
    scope.__firstPage = null;
    performance.setResourceTimingBufferSize(5000);
    new MutationObserver(() => {
      if (
        scope.__firstPage === null &&
        document.querySelector('.reading-pdf-page[data-rendered="true"]')
      )
        scope.__firstPage = performance.now();
    }).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-rendered"],
    });
  });
}
const firstPage = (page: Page) =>
  page
    .waitForFunction(
      () => (window as unknown as { __firstPage: number | null }).__firstPage,
      undefined,
      { timeout: 60_000, polling: 16 },
    )
    .then((handle) => handle.jsonValue() as Promise<number>);
/** The first PDF byte request's start, in ms since navigation start. */
const firstByteRequest = (page: Page) =>
  page.evaluate(
    () =>
      (
        performance.getEntriesByType("resource") as PerformanceResourceTiming[]
      ).find((e) => e.name.includes("/query/material-bytes"))?.startTime ??
      null,
  );
/**
 * PDF byte requests of this page load around its first drawn page, in the
 * page's own clock: those finished before it and the bytes they carried.
 */
const beforeFirstPage = (page: Page) =>
  page.evaluate(() => {
    const first =
      (window as unknown as { __firstPage: number | null }).__firstPage ??
      Infinity;
    const pdf = (
      performance.getEntriesByType("resource") as PerformanceResourceTiming[]
    ).filter((e) => e.name.includes("/query/material-bytes"));
    const done = pdf.filter((e) => e.responseEnd <= first);
    return {
      started: pdf.filter((e) => e.startTime <= first).length,
      finished: done.length,
      bytes: done.reduce((n, e) => n + e.encodedBodySize, 0),
    };
  });
async function settled(network: Network) {
  await expect
    .poll(() => network.pending(), { timeout: 60_000, interval: 100 })
    .toBe(false);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await expect
    .poll(() => network.pending(), { timeout: 60_000, interval: 100 })
    .toBe(false);
}
const summary = (requests: Request[], size: number) => {
  const network = requests.filter((r) => !r.cached);
  const bytes = network.reduce((n, r) => n + r.bytes, 0);
  return {
    requests: requests.length,
    from_network: network.length,
    from_cache: requests.length - network.length,
    network_bytes: bytes,
    ratio_to_size: Math.round((bytes / size) * 1000) / 1000,
  };
};
const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const probe = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          __sciretrieverReaderProbe?: {
            pdfRequests: Record<string, number>;
            pdfHashes: Record<string, number>;
            workersStarted: number;
            workersTerminated: number;
            objectUrlsCreated: number;
            objectUrlsRevoked: number;
          };
        }
      ).__sciretrieverReaderProbe ?? null,
  );
const readerUrl = (w: Workspace, id: string) =>
  `${w.origin}/?literature=${id}&reader=pdf`;
async function closeAllTabs(page: Page) {
  while (await page.getByRole("button", { name: /^关闭文献 / }).count())
    await page
      .getByRole("button", { name: /^关闭文献 / })
      .first()
      .click();
  await page.waitForFunction(
    () => !document.querySelector(".reader-engine-body .reading-pdf-page"),
  );
}
async function reportFile() {
  const directory =
    process.env.SCIRETRIEVER_PDF_REPORT_DIR ??
    (await mkdtemp(join(tmpdir(), "sciretriever-pdf-progressive-")));
  await mkdir(directory, { recursive: true });
  return join(
    directory,
    `pdf-progressive-${process.env.SCIRETRIEVER_PDF_REPORT_LABEL ?? new Date().toISOString().replaceAll(":", "-")}.json`,
  );
}

const large = paddedPdf(100, 200 * 1024),
  interleaved = paddedPdf(100, 200 * 1024, "interleaved"),
  interleavedId = "00000000-0000-0000-0000-000000005203",
  medium = paddedPdf(20, 100 * 1024),
  mediumId = "00000000-0000-0000-0000-000000005201";
async function addPaper(
  env: Parameters<
    NonNullable<Parameters<typeof nextWorkspace>[0]>["setup"] & {}
  >[0],
  id: string,
  title: string,
  bytes: Buffer,
) {
  await env.app.database.putLiterature(
    parseLiterature({
      ...FIXTURE_LITERATURE,
      literature_id: id,
      meta_literature_id: id.replace(/.$/u, "9"),
      metadata: { ...FIXTURE_LITERATURE.metadata, title, identifiers: [] },
    }),
  );
  await env.app.maintenance!.ingestPdf({ literature_id: id, bytes });
}
async function addMedium(
  env: Parameters<
    NonNullable<Parameters<typeof nextWorkspace>[0]>["setup"] & {}
  >[0],
) {
  await env.app.database.putLiterature(
    parseLiterature({
      ...FIXTURE_LITERATURE,
      literature_id: mediumId,
      meta_literature_id: "00000000-0000-0000-0000-000000005202",
      metadata: {
        ...FIXTURE_LITERATURE.metadata,
        title: "Medium source",
        identifiers: [],
      },
    }),
  );
  await env.app.maintenance!.ingestPdf({
    literature_id: mediumId,
    bytes: medium,
  });
}

it("reuses the PDF URL and browser cache across a reload with a fresh Workbench grant", async () => {
  const w = await nextWorkspace({ ready: "body", readerProbe: true });
  try {
    await markFirstPage(w.page);
    const network = await watchNetwork(w.page);
    const paper = w.env.parseRequest.literature_id;
    const asset = w.env.asset;
    const expectedUrl = `${w.origin}/api/v1/query/material-bytes/${paper}/${asset.asset_id}/${asset.sha256}`;
    const read = async () => {
      await firstPage(w.page);
      await w.page.waitForFunction(
        () =>
          performance.getEntriesByName("sciretriever-pdf-verified").length > 0,
      );
      await settled(network);
      const requests = network.take();
      expect(new Set(requests.map((request) => request.url))).toEqual(
        new Set([expectedUrl]),
      );
      expect(requests.every((request) => Boolean(request.clientId))).toBe(true);
      return requests;
    };
    await network.cdp.send("Network.clearBrowserCache");
    await w.page.goto(readerUrl(w, paper));
    const cold = await read();
    expect(
      cold.some(
        (request) =>
          !request.cached && request.range !== null && request.status === 206,
      ),
    ).toBe(true);
    await w.page.reload();
    const warm = await read();
    expect(
      warm.every((request) => request.clientId !== cold[0]!.clientId),
    ).toBe(true);
    expect(warm.some((request) => request.cached)).toBe(true);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 120_000);

it("measures the first page, a second open and the bytes of large and small PDFs (spec 8.2)", async () => {
  const w = await nextWorkspace({
    ready: "body",
    readerProbe: true,
    setup: async (env) => {
      await env.app.maintenance!.ingestPdf({
        literature_id: missingId,
        bytes: large,
      });
      await addMedium(env);
      await addPaper(env, interleavedId, "Interleaved source", interleaved);
    },
  });
  try {
    await markFirstPage(w.page);
    const network = await watchNetwork(w.page);
    const papers = {
      large: { id: missingId, size: large.length },
      large_interleaved: { id: interleavedId, size: interleaved.length },
      medium: { id: mediumId, size: medium.length },
      small: {
        id: w.env.parseRequest.literature_id,
        size: w.env.asset.size_bytes,
      },
    };
    const result: Record<string, unknown> = {
      created_at: new Date().toISOString(),
      sizes: Object.fromEntries(
        Object.entries(papers).map(([name, paper]) => [name, paper.size]),
      ),
      load: loadavg(),
    };
    for (const [name, paper] of Object.entries(papers)) {
      const runs: Record<string, unknown>[] = [];
      for (let run = 0; run < 3; run++) {
        await network.cdp.send("Network.clearBrowserCache");
        // Cold: a new page load, an empty HTTP cache and no session memory.
        await w.page.goto(readerUrl(w, paper.id));
        const cold = await firstPage(w.page),
          request = await firstByteRequest(w.page),
          needed = await beforeFirstPage(w.page);
        const untilFirst = network.take();
        await settled(network);
        const coldFirst = summary(untilFirst, paper.size),
          coldAll = summary([...untilFirst, ...network.take()], paper.size);
        // In the same page: close the paper and open it again (session memory).
        await closeAllTabs(w.page);
        await w.page.evaluate(() => {
          (window as unknown as { __firstPage: number | null }).__firstPage =
            null;
        });
        const reopenStart = await w.page.evaluate(() => performance.now());
        await w.page.evaluate((url) => {
          history.pushState(null, "", url);
          dispatchEvent(new PopStateEvent("popstate"));
        }, `/?literature=${paper.id}&reader=pdf`);
        const reopen = (await firstPage(w.page)) - reopenStart;
        await settled(network);
        const reopenNet = summary(network.take(), paper.size);
        // A reload: a new page and workbench grant, the HTTP cache kept.
        await w.page.reload();
        const reload = await firstPage(w.page);
        await settled(network);
        const reloadNet = summary(network.take(), paper.size);
        runs.push({
          cold_ms: Math.round(cold),
          cold_from_first_byte_request_ms:
            request === null ? null : Math.round(cold - request),
          cold_requests_until_first_page: coldFirst,
          cold_finished_before_first_page: needed,
          cold_requests_total: coldAll,
          reopen_same_page_ms: Math.round(reopen),
          reopen_same_page: reopenNet,
          reload_ms: Math.round(reload),
          reload: reloadNet,
        });
      }
      // A slower link (40 Mbit/s, 20 ms each way): where ranges pay off.
      await network.cdp.send("Network.clearBrowserCache");
      await network.cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 20,
        downloadThroughput: 5 * 1024 * 1024,
        uploadThroughput: 5 * 1024 * 1024,
      });
      await w.page.goto(readerUrl(w, paper.id));
      const slow = await firstPage(w.page),
        slowRequest = await firstByteRequest(w.page),
        slowNeeded = await beforeFirstPage(w.page);
      const slowFirst = summary(network.take(), paper.size);
      await settled(network);
      const slowRest = summary(network.take(), paper.size);
      await network.cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
      result[name] = {
        size: paper.size,
        cold_ms_median: median(runs.map((r) => r.cold_ms as number)),
        reopen_same_page_ms_median: median(
          runs.map((r) => r.reopen_same_page_ms as number),
        ),
        reload_ms_median: median(runs.map((r) => r.reload_ms as number)),
        runs,
        slow_link: {
          cold_ms: Math.round(slow),
          cold_from_first_byte_request_ms:
            slowRequest === null ? null : Math.round(slow - slowRequest),
          until_first_page: slowFirst,
          finished_before_first_page: slowNeeded,
          after_first_page: slowRest,
        },
      };
    }
    result.counters = await probe(w.page);
    const file = await reportFile();
    await writeFile(file, JSON.stringify(result, null, 2) + "\n");
    process.stdout.write(`pdf progressive report: ${file}\n`);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 600_000);

it("replaces a PDF whose whole check fails with “文件与记录不一致”, releases it and reads past the cache next time (spec 6.3, 8.2)", async () => {
  const w = await nextWorkspace({
    ready: "body",
    readerProbe: true,
    setup: addMedium,
  });
  try {
    await markFirstPage(w.page);
    const network = await watchNetwork(w.page);
    // The file on the server stays as recorded; a later part of it arrives
    // changed in transit (same size and headers), which only the whole
    // SHA-256 can tell. The first page shows before that part is in.
    let tampered = 0,
      release!: () => void;
    // The later parts are held back, so the whole check is still under way.
    const held = new Promise<void>((resolve) => (release = resolve));
    await w.page.route(
      (url) => url.pathname.startsWith("/api/v1/query/material-bytes/"),
      async (route) => {
        const response = await route.fetch();
        const body = await response.body();
        const range = /^bytes (\d+)-(\d+)\//u.exec(
          response.headers()["content-range"] ?? "",
        );
        // The byte at 1 MB, which neither the first page nor the
        // cross-reference at the end needs; held until the menu is checked.
        const start = Number(range?.[1] ?? -1),
          end = Number(range?.[2] ?? -1);
        if (start <= 1024 * 1024 && end >= 1024 * 1024) {
          await held;
          body[1024 * 1024 - start] = body[1024 * 1024 - start]! ^ 1;
          tampered++;
        }
        await route.fulfill({ response, body });
      },
    );
    await w.page.goto(readerUrl(w, mediumId));
    await firstPage(w.page);
    // While the check runs, “下载 PDF” waits and says why.
    const downloadItem = w.page.getByRole("menuitem", {
      name: "下载 PDF",
      exact: true,
    });
    await w.page.getByRole("button", { name: "更多", exact: true }).click();
    expect(await downloadItem.getAttribute("aria-disabled")).toBe("true");
    expect(
      await downloadItem.evaluate((item) =>
        (item.getAttribute("aria-describedby") ?? "")
          .split(" ")
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(""),
      ),
    ).toBe("正在核对文件与记录，完成后可下载");
    await w.page.keyboard.press("Escape");
    release();
    const notice = w.page.locator(".reader-surface .ui-error-notice");
    await expect
      .poll(() => notice.innerText(), { timeout: 30_000 })
      .toContain("文件与记录不一致");
    expect(tampered).toBeGreaterThan(0);
    expect(await notice.innerText()).toContain("重试会重新下载这份 PDF");
    // The pages are released and nothing of the file is offered.
    expect(await w.page.locator(".reading-pdf-page").count()).toBe(0);
    expect(await w.page.locator(".reader-engine-body canvas").count()).toBe(0);
    const failed = (await probe(w.page))!;
    expect(failed.workersStarted - failed.workersTerminated).toBe(0);
    expect(failed.objectUrlsCreated - failed.objectUrlsRevoked).toBe(0);
    await w.page.getByRole("button", { name: "更多", exact: true }).click();
    expect(await downloadItem.getAttribute("aria-disabled")).toBe("true");
    // The notice says what went wrong; the item no longer says it is checking.
    expect(await downloadItem.innerText()).not.toContain("正在核对");
    await w.page.keyboard.press("Escape");
    // The next open of this file reads past the browser cache.
    expect(
      await w.page.evaluate(() =>
        localStorage.getItem("sciretriever.pdf-refetch"),
      ),
    ).toContain(createHash("sha256").update(medium).digest("hex"));
    // Repaired in transit: 重试 reads it again past the browser cache.
    await w.page.unrouteAll({ behavior: "wait" });
    await settled(network);
    network.take();
    await w.page.evaluate(() => {
      (window as unknown as { __firstPage: number | null }).__firstPage = null;
    });
    await notice.getByRole("button", { name: "重试", exact: true }).click();
    await firstPage(w.page);
    await settled(network);
    const retried = network.take();
    expect(retried.length).toBeGreaterThan(0);
    expect(retried.every((r) => r.cacheControl === "no-cache")).toBe(true);
    expect(await notice.count()).toBe(0);
    // Passed: the mark is gone and the checked file can be downloaded.
    await expect
      .poll(() =>
        w.page.evaluate(() => localStorage.getItem("sciretriever.pdf-refetch")),
      )
      .toBeNull();
    await w.page.getByRole("button", { name: "更多", exact: true }).click();
    const [download] = await Promise.all([
      w.page.waitForEvent("download"),
      w.page.getByRole("menuitem", { name: "下载 PDF", exact: true }).click(),
    ]);
    expect(
      Buffer.compare(await readFile((await download.path())!), medium),
    ).toBe(0);
    // A later page load reads it normally again.
    await w.page.reload();
    await firstPage(w.page);
    await settled(network);
    expect(network.take().some((r) => r.cacheControl === "no-cache")).toBe(
      false,
    );
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 180_000);
