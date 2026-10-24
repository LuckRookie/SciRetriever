import { expect, it } from "vitest";
import { nextWorkspace } from "./next-workspace-fixture.js";

const SEARCH = /\/api\/(?:v1\/query\/search|library\/search)$/u;

it(
  "finds and opens papers from the command palette by keyboard, cancelling superseded searches",
  { timeout: 60000 },
  async () => {
    const w = await nextWorkspace();
    try {
      const page = w.page;
      // Opening a paper puts it in "recently read", which an empty palette lists.
      const first = page.locator(".paper-row .paper-title").first();
      const recent = (await first.textContent())!;
      await first.click();
      await expect
        .poll(() => new URL(page.url()).searchParams.get("literature"))
        .not.toBeNull();
      await page.keyboard.press("Control+k");
      const palette = page.getByRole("dialog", {
        name: "搜索文献",
        exact: true,
      });
      await palette.getByText("最近阅读", { exact: true }).waitFor();
      await expect
        .poll(() => palette.getByRole("option").first().textContent())
        .toContain(recent);

      // Hold the first typed search so the next keystrokes supersede it, and
      // record which search bodies the page itself aborts.
      await page.evaluate(() => {
        const aborted: string[] = [];
        Object.assign(window, { abortedSearches: aborted });
        const original = window.fetch.bind(window);
        window.fetch = (input, init) => {
          const body = typeof init?.body === "string" ? init.body : "";
          init?.signal?.addEventListener("abort", () => aborted.push(body));
          return original(input, init);
        };
      });
      const aborted = () =>
        page.evaluate(() =>
          (
            (window as unknown as { abortedSearches: string[] })
              .abortedSearches ?? []
          ).some((body) => body.includes('"text":"Unp"')),
        );
      await page.route(SEARCH, async (route) => {
        if (/"text":"Unp"/u.test(route.request().postData() ?? ""))
          await new Promise((resolve) => setTimeout(resolve, 1500));
        await route.continue().catch(() => undefined);
      });
      const input = palette.getByRole("combobox", { name: "搜索文献" });
      await input.pressSequentially("Unp");
      await page.waitForRequest(
        (request) =>
          SEARCH.test(new URL(request.url()).pathname) &&
          /"text":"Unp"/u.test(request.postData() ?? ""),
      );
      await input.pressSequentially("arsed");
      const option = palette.getByRole("option", { name: /Unparsed source/u });
      await option.waitFor();
      await expect.poll(aborted).toBe(true);
      await expect(
        palette
          .getByRole("button", { name: /^在文献库中查看全部 \d+ 条$/u })
          .count(),
      ).resolves.toBe(1);

      // Arrow keys move the selection; Enter opens the selected paper.
      await input.press("ArrowDown");
      await input.press("ArrowUp");
      await expect(option.getAttribute("aria-selected")).resolves.toBe("true");
      await input.press("Enter");
      await palette.waitFor({ state: "detached" });
      await page
        .getByRole("navigation", { name: "工作区与阅读标签" })
        .getByRole("button", { name: "Unparsed source", exact: true })
        .waitFor();

      // Ctrl+Enter shows every match in the library instead.
      await page.keyboard.press("Control+k");
      await palette.getByRole("combobox").fill("Unparsed");
      await palette.getByRole("option", { name: /Unparsed source/u }).waitFor();
      await page.keyboard.press("Control+Enter");
      await expect
        .poll(() =>
          JSON.parse(new URL(page.url()).searchParams.get("query") ?? "{}"),
        )
        .toMatchObject({ text: "Unparsed" });
      expect(new URL(page.url()).searchParams.get("literature")).toBeNull();
      await expect.poll(() => page.locator(".paper-row").count()).toBe(1);
    } finally {
      await w.close();
    }
  },
);
