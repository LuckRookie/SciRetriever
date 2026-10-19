import { expect, it } from "vitest";
import { nextWorkspace } from "./next-workspace-fixture.js";
it("preserves the current system theme and keeps explicit themes stable when the OS changes", async () => {
  const w = await nextWorkspace();
  try {
    const page = w.page;
    await page.evaluate(() =>
      localStorage.setItem(
        "sciretriever:react:sciretriever:theme:v1",
        "system",
      ),
    );
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto(`${w.origin}/?view=set&setting=appearance`);
    const theme = () => page.locator("html").getAttribute("data-theme");
    await expect.poll(theme).toBe("dark");
    await page
      .getByRole("button", { name: "跟随系统 主题", exact: true })
      .waitFor();
    await page.emulateMedia({ colorScheme: "light" });
    await expect.poll(theme).toBe("light");
    for (const [name, value] of [
      ["蓝白", "light"],
      ["深色", "dark"],
      ["墨绿", "green"],
      ["暖白", "warm"],
    ] as const) {
      await page.getByRole("button", { name: /主题$/ }).click();
      await page.getByRole("option", { name, exact: true }).click();
      await expect.poll(theme).toBe(value);
      await page.emulateMedia({ colorScheme: "dark" });
      expect(await theme()).toBe(value);
      await page.emulateMedia({ colorScheme: "light" });
      expect(await theme()).toBe(value);
    }
    expect(
      await page.evaluate(() => localStorage.getItem("sciretriever:theme:v1")),
    ).toBeNull();
    expect(
      await page.evaluate(() =>
        localStorage.getItem("sciretriever:react:sciretriever:theme:v1"),
      ),
    ).toBe("warm");
    await page.reload();
    await expect.poll(theme).toBe("warm");
    await page.getByRole("button", { name: /主题$/ }).click();
    await page.getByRole("option", { name: "跟随系统", exact: true }).click();
    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(theme).toBe("dark");
    expect(w.errors).toEqual([]);
  } finally {
    await w.close();
  }
}, 60000);
