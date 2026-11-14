import { expect, it } from "vitest";
import { nextWorkspace } from "./next-workspace-fixture.js";

const paragraphs = (length: number, marker = "a reported measurement") =>
  Array.from(
    { length },
    (_, i) => `Paragraph ${i}: ${marker} with conditions and evidence.\n\n`,
  ).join("");

// Spec 5.2: background refresh updates the panels and offers a new text
// version; it never rebuilds the reader, moves the text or takes the focus.
it("keeps the reader through a minute of background refresh and offers a new text version", async () => {
  const w = await nextWorkspace({
    ready: "body",
    readerProbe: true,
    setup: async (env) => env.setText(paragraphs(300)),
  });
  const app = w.env.app,
    id = w.env.parseRequest.literature_id,
    request = {
      literature_id: id,
      asset_id: w.env.parseRequest.asset_id,
      asset_sha256: w.env.parseRequest.asset_sha256,
    };
  const jobs: string[] = [];
  let polls = 0;
  w.page.on("response", (response) => {
    if (new URL(response.url()).pathname === "/api/tasks") polls++;
  });
  // A task appears or ends: the activity poll sees a change and refreshes materials.
  const changeTasks = async (tick: number) => {
    if (tick % 2 === 0) {
      const job = await app.processingTasks!.submit({
        schema_version: 1,
        idempotency_key: `reader-refresh-${tick}-${Date.now()}`,
        operations: [
          {
            operation: "parse-documents",
            request: { ...request, profiles: ["vlm-engine"], force: false },
          },
        ],
      });
      jobs.push(job.job_id);
    } else await app.processingTasks!.control(jobs.at(-1)!, "cancel");
  };
  const engines = () =>
    w.page.evaluate(() =>
      Object.values(
        (
          window as unknown as {
            __sciretrieverReaderProbe: { engines: Record<string, number> };
          }
        ).__sciretrieverReaderProbe.engines,
      ).reduce((sum, n) => sum + n, 0),
    );
  const article = w.page.locator(
    '.reader-view[data-view="doc"]:not([hidden]) .reading-article',
  );
  const body = w.page.locator(".reader-engine-body");
  try {
    await w.page.goto(`${w.origin}/?literature=${id}&reader=doc`);
    await article.locator("section[data-byte-start]").first().waitFor();
    await body.evaluate((el) => {
      el.scrollTop = 1500;
    });
    const find = w.page.getByRole("button", {
      name: "文档内查找",
      exact: true,
    });
    await find.focus();
    const before = {
      scroll: await body.evaluate((el) => el.scrollTop),
      text: await article.innerText(),
      engines: await engines(),
    };
    expect(before.scroll).toBe(1500);
    for (let tick = 0; tick < 12; tick++) {
      await changeTasks(tick);
      const state = await app.metadataFields.read(id);
      await app.metadataFields.edit({
        literature_id: id,
        expected_revision: state.metadata_revision,
        set: [
          {
            field: "article_kind",
            value: tick % 2 ? "research-article" : "correction-or-editorial",
          },
        ],
        unlock: [],
      });
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    expect(polls).toBeGreaterThanOrEqual(10);
    expect(await engines()).toBe(before.engines);
    expect(await body.evaluate((el) => el.scrollTop)).toBe(before.scroll);
    expect(await article.innerText()).toBe(before.text);
    expect(await find.evaluate((el) => el === document.activeElement)).toBe(
      true,
    );
    // A new default text version is offered in the status bar, not swapped in.
    w.env.setText(paragraphs(300, "a revised measurement"));
    await w.env.build(request);
    await changeTasks(12);
    const status = w.page.locator(".reading-status");
    await expect
      .poll(() => status.innerText(), { timeout: 20_000 })
      .toContain("有新版本文本。");
    expect(await article.innerText()).toBe(before.text);
    expect(await body.evaluate((el) => el.scrollTop)).toBe(before.scroll);
    expect(await engines()).toBe(before.engines);
    await status.getByRole("button", { name: "切换", exact: true }).click();
    await expect
      .poll(() => article.innerText(), { timeout: 20_000 })
      .toContain("a revised measurement");
    expect(await status.innerText()).not.toContain("有新版本文本。");
    expect(w.errors).toEqual([]);
  } finally {
    for (const job of jobs)
      await app.processingTasks!.control(job, "cancel").catch(() => undefined);
    await w.close();
  }
}, 180_000);
