import { afterEach, expect, it, vi } from "vitest";
import { preferences, readTheme } from "../src/app/data/preferences.js";
import { parseLibrarySearchRequest } from "@sciretriever/contracts";
import { nextWorkspace, openSavedViews } from "./next-workspace-fixture.js";
const prefix = "sciretriever:react:";
afterEach(() => vi.unstubAllGlobals());
it("reads and writes only current UI preferences without migrating old keys; a retired theme name is replaced", () => {
  const values = new Map([
    ["sciretriever:theme:v1", "green"],
    ["other-app:theme", "dark"],
  ]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  expect(readTheme()).toBe("light");
  expect(preferences.read("sciretriever:theme:v1")).toBeNull();
  preferences.write("sciretriever:theme:v1", "xuan");
  expect(readTheme()).toBe("xuan");
  // 暖白 is now 纸墨; the stored name is rewritten once.
  preferences.write("sciretriever:theme:v1", "warm");
  expect(readTheme()).toBe("light");
  expect(values).toEqual(
    new Map([
      ["sciretriever:theme:v1", "green"],
      ["other-app:theme", "dark"],
      [prefix + "sciretriever:theme:v1", "light"],
    ]),
  );
});
it("restores current theme, panel width and saved view through application startup", async () => {
  const w = await nextWorkspace();
  try {
    const values = {
      [prefix + "sciretriever:theme:v1"]: "bean",
      [prefix + "sciretriever:panel:navigation:v1"]: "330px",
      [prefix + "sciretriever:library-views:v1:unbound"]: JSON.stringify([
        {
          id: "saved-view",
          name: "My library view",
          ...parseLibrarySearchRequest({
            query: {},
            sort: "publication-year-desc",
          }),
        },
      ]),
      "sciretriever:theme:v1": "dark",
      "unrelated-app:value": "untouched",
    };
    await w.page.evaluate((values) => {
      localStorage.clear();
      for (const [key, value] of Object.entries(values))
        localStorage.setItem(key, value);
    }, values);
    await w.page.goto(`${w.origin}/?view=lib`);
    await (
      await openSavedViews(w.page)
    )
      // The browser's saved view is no filter now: it waits to be imported (user organization 9.1).
      .getByRole("menuitem", {
        name: "导入这个浏览器里保存的筛选（1 项）",
        exact: true,
      })
      .waitFor();
    await w.page.keyboard.press("Escape");
    expect(await w.page.locator("html").getAttribute("data-theme")).toBe(
      "bean",
    );
    expect(
      await w.page
        .locator(".navigation")
        .evaluate((el) => el.getBoundingClientRect().width),
    ).toBe(330);
    const stored = await w.page.evaluate(() => ({ ...localStorage }));
    for (const [key, value] of Object.entries(values))
      expect(stored[key]).toBe(value);
    expect(stored[prefix + "preferences-migrated:v1"]).toBeUndefined();
    await w.page.reload();
    await (
      await openSavedViews(w.page)
    )
      // The browser's saved view is no filter now: it waits to be imported (user organization 9.1).
      .getByRole("menuitem", {
        name: "导入这个浏览器里保存的筛选（1 项）",
        exact: true,
      })
      .waitFor();
    await w.page.keyboard.press("Escape");
    expect(await w.page.locator("html").getAttribute("data-theme")).toBe(
      "bean",
    );
    expect(w.env.modelCalls).toBe(0);
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 30000);
it("uses defaults when browser storage is unavailable and allows session-only writes", () => {
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new Error("Synthetic security failure");
    },
    setItem: () => {
      throw new Error("Synthetic quota failure");
    },
  });
  expect(readTheme()).toBe("light");
  expect(() =>
    preferences.write("sciretriever:theme:v1", "green"),
  ).not.toThrow();
});
