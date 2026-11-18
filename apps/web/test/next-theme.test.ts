import { expect, it } from "vitest";
import { nextWorkspace } from "./next-workspace-fixture.js";

const key = "sciretriever:react:sciretriever:theme:v1";
// Design core “主题”: the seven themes as “设置 → 外观” names them.
const themes = [
  ["纸墨", "light"],
  ["旧书", "oldbook"],
  ["宣纸", "xuan"],
  ["豆绿", "bean"],
  ["墨水屏", "eink"],
  ["夜读", "dark"],
  ["烛光", "candle"],
] as const;

it("follows the system with separate day and night themes, and keeps an explicit theme when the OS changes", async () => {
  const w = await nextWorkspace();
  try {
    const page = w.page;
    await page.evaluate((key) => localStorage.setItem(key, "system"), key);
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(`${w.origin}/?view=set&setting=appearance`);
    const theme = () => page.locator("html").getAttribute("data-theme");
    const card = (name: string) =>
      page.locator("label.theme-card").filter({
        has: page.getByRole("radio", { name, exact: true }),
      });
    // Defaults: 纸墨 by day, 夜读 by night.
    await expect.poll(theme).toBe("dark");
    expect(
      await page
        .getByRole("radio", { name: "跟随系统", exact: true })
        .isChecked(),
    ).toBe(true);
    await page.emulateMedia({ colorScheme: "light" });
    await expect.poll(theme).toBe("light");
    // The night theme is chosen on its own and applies once the OS is dark.
    await page.getByRole("button", { name: "夜读 夜里用的主题" }).click();
    await page.getByRole("option", { name: "烛光", exact: true }).click();
    expect(await theme()).toBe("light");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(theme).toBe("candle");
    await page.getByRole("button", { name: "纸墨 白天用的主题" }).click();
    await page.getByRole("option", { name: "豆绿", exact: true }).click();
    await page.emulateMedia({ colorScheme: "light" });
    await expect.poll(theme).toBe("bean");
    expect(
      await page.evaluate(() => ({
        day: localStorage.getItem(
          "sciretriever:react:sciretriever:theme:day:v1",
        ),
        night: localStorage.getItem(
          "sciretriever:react:sciretriever:theme:night:v1",
        ),
      })),
    ).toEqual({ day: "bean", night: "candle" });
    // Each card applies at once, paints its own paper, and stays put when
    // the OS changes; the day and night choices are hidden meanwhile.
    const papers = new Set<string>();
    for (const [name, value] of themes) {
      await card(name).click();
      await expect.poll(theme).toBe(value);
      expect(
        await page.getByRole("radio", { name, exact: true }).isChecked(),
      ).toBe(true);
      await page.emulateMedia({ colorScheme: "dark" });
      expect(await theme()).toBe(value);
      await page.emulateMedia({ colorScheme: "light" });
      expect(await theme()).toBe(value);
      papers.add(
        await page.evaluate(
          () => getComputedStyle(document.body).backgroundColor,
        ),
      );
    }
    expect(papers.size).toBe(themes.length);
    expect(
      await page.getByRole("button", { name: /夜里用的主题$/ }).count(),
    ).toBe(0);
    expect(
      await page.evaluate(() => localStorage.getItem("sciretriever:theme:v1")),
    ).toBeNull();
    expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
      "candle",
    );
    await page.reload();
    await expect.poll(theme).toBe("candle");
    // Back to the system: the separate choices are kept.
    await card("跟随系统").click();
    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(theme).toBe("candle");
    await page.emulateMedia({ colorScheme: "light" });
    await expect.poll(theme).toBe("bean");
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);

it("replaces retired theme names with their successors and stores the new name", async () => {
  const w = await nextWorkspace();
  try {
    const page = w.page;
    const theme = () => page.locator("html").getAttribute("data-theme");
    // 暖白 and 蓝白 become 纸墨, 墨绿 becomes 豆绿, 深色 becomes 夜读.
    for (const [stored, next] of [
      ["warm", "light"],
      ["green", "bean"],
      ["light", "light"],
      ["dark", "dark"],
    ] as const) {
      await page.evaluate(
        ([key, stored]) => {
          localStorage.setItem(key, stored);
          localStorage.setItem(
            "sciretriever:react:sciretriever:theme:night:v1",
            stored,
          );
        },
        [key, stored] as const,
      );
      await page.goto(`${w.origin}/?view=set&setting=appearance`);
      await expect.poll(theme).toBe(next);
      expect(
        await page.evaluate(
          (key) => [
            localStorage.getItem(key),
            localStorage.getItem(
              "sciretriever:react:sciretriever:theme:night:v1",
            ),
          ],
          key,
        ),
      ).toEqual([next, next]);
      const name = themes.find(([, id]) => id === next)![0];
      expect(
        await page.getByRole("radio", { name, exact: true }).isChecked(),
      ).toBe(true);
    }
    // An unknown name is ignored: the default theme, nothing rewritten.
    await page.evaluate((key) => localStorage.setItem(key, "neon"), key);
    await page.goto(`${w.origin}/?view=set&setting=appearance`);
    await expect.poll(theme).toBe("light");
    expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(
      "neon",
    );
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);
