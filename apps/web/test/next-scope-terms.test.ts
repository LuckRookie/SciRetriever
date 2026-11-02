import { expect, it } from "vitest";
import { nextWorkspace } from "./next-workspace-fixture.js";
import { topicDraft } from "../../server/test/tag-fixture.js";

const encode = (value: object) => encodeURIComponent(JSON.stringify(value));

it("lists tags first with each layer's coverage, folds subjects once most results are tagged and swaps a keyword for its tag", async () => {
  const w = await nextWorkspace({});
  try {
    const page = w.page,
      tags = w.env.app.tags;
    const ids: string[] = [];
    for (const name of ["Sodium-ion batteries", "Cathode materials"]) {
      const changed = await tags.change({
        mutation: { op: "create", tag: topicDraft(name) },
        expected_version: (await tags.state()).version,
        reason: "Synthetic scope vocabulary",
      });
      ids.push(changed.inverse[0]!.tag_id);
    }
    // The layers' shape is the server's (technical/06 2.1.6); this checks the page.
    await page.route("**/api/v1/query/library-facets?*", (route) =>
      route.fulfill({
        status: 200,
        json: {
          protocol_version: 1,
          result: {
            total: 40,
            coverage: { tags: 24, keywords: 40, subject_terms: 40 },
            tags: [
              { tag_id: ids[0], value: "Sodium-ion batteries", count: 20 },
              { tag_id: ids[1], value: "Cathode materials", count: 9 },
            ],
            keywords: [
              {
                value: "Sodium-ion battery",
                count: 40,
                tag: { tag_id: ids[0], name: "Sodium-ion batteries" },
              },
              { value: "Cathode", count: 6, tag: null },
            ],
            subject_terms: [{ value: "Chemistry", count: 38 }],
          },
        },
      }),
    );
    await page.goto(
      new URL(
        `/?view=lib&query=${encode({ keywords: ["Sodium-ion battery"] })}`,
        page.url(),
      ).href,
    );
    const terms = page.getByRole("region", { name: "范围内的词" });
    await terms.waitFor();
    const rows = terms.locator(".scope-terms-row");
    expect(
      await rows.evaluateAll((r) => r.map((e) => e.dataset.layer)),
    ).toEqual(["tags", "keywords", "subject_terms"]);
    expect(
      await rows.nth(0).locator(".scope-terms-coverage").textContent(),
    ).toBe("24 / 40 篇");
    // Over half the results carry tags, so subjects wait behind “展开”.
    expect(
      await terms.getByRole("button", { name: /^主题词 Chemistry/ }).count(),
    ).toBe(0);
    await terms.getByRole("button", { name: "展开", exact: true }).click();
    await terms
      .getByRole("button", { name: "主题词 Chemistry，38 篇", exact: true })
      .waitFor();
    // The picked keyword names a tag: swap it for the tag.
    await terms
      .getByRole("button", {
        name: "作者关键词 Sodium-ion battery，40 篇，对应标签 Sodium-ion batteries",
        exact: true,
      })
      .waitFor();
    expect(await terms.locator(".scope-terms-hint").textContent()).toContain(
      "“Sodium-ion battery”对应标签“Sodium-ion batteries”",
    );
    await terms
      .getByRole("button", { name: "改用标签筛选", exact: true })
      .click();
    const read = () =>
      JSON.parse(new URL(page.url()).searchParams.get("query") ?? "{}");
    await expect.poll(() => read().tags?.ids).toEqual([ids[0]]);
    expect(read().keywords ?? []).toEqual([]);
    // A tag click adds it to the tag filter, any rank.
    await terms
      .getByRole("button", {
        name: "标签 Cathode materials，9 篇",
        exact: true,
      })
      .click();
    await expect.poll(() => read().tags).toEqual({ ids, mode: "any" });
    expect(
      await terms
        .getByRole("button", {
          name: "标签 Cathode materials，9 篇",
          exact: true,
        })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(w.env.modelCalls).toBe(0);
  } finally {
    await w.close();
  }
}, 60000);
