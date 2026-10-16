import {
  parseLiteratureSearchItem,
  type LiteratureSearchItem,
} from "@sciretriever/contracts";
import { record } from "../wire.js";
import { search, detail, title, capabilityMenu } from "./library.js";
import { node, escape as e, click, failure } from "./dom.js";
import type { AppContext } from "./types.js";
export async function renderInsights(ctx: AppContext): Promise<void> {
  ctx.root.innerHTML =
    '<div class="pg"><div class="pgin"><h1 class="ptitle">洞察</h1><p class="pdesc">查看当前范围的年份、关键词、期刊和材料状态，统计只使用库内已有事实。</p><div class="vtabs"><button class="vt on" id="ins-stats">统计</button><button class="vt" id="ins-map">引用网络</button><div class="vtools"><button class="btn q sm" id="ins-cap">用这些文献做…</button></div></div><p id="ins-status" role="status">正在读取…</p><div id="ins-content"></div></div></div>';
  const content = node("#ins-content", ctx.root);
  const items: LiteratureSearchItem[] = [];
  try {
    if (
      new URL(location.href).searchParams.get("scope") === "selection" &&
      ctx.library.selected.size
    ) {
      for (const id of ctx.library.selected) {
        items.push(await detail(ctx, id));
        if (ctx.signal.aborted) return;
      }
    } else {
      let cursor: string | null = null;
      do {
        const page = await search(ctx, cursor);
        items.push(...page.items);
        cursor = page.cursor;
        if (ctx.signal.aborted) return;
      } while (cursor && items.length < 1000);
    }
    node("#ins-status", ctx.root).textContent =
      `基于当前范围 ${items.length} 篇已读取文献${items.length >= 1000 ? "（本次最多读取 1000 篇）" : ""}。计数不推断缺失字段。`;
    const group = (values: readonly string[]) => {
      const counts = new Map<string, number>();
      for (const value of values)
        if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
      return [...counts].sort((a, b) => b[1] - a[1]);
    };
    const groups = [
      {
        id: "year",
        name: "年份分布",
        rows: group(
          items.map((p) =>
            String(p.literature.metadata.publication_year ?? "未提供"),
          ),
        ),
      },
      {
        id: "tag",
        name: "元数据关键词",
        rows: group(
          items.flatMap((p) => [...new Set(p.literature.metadata.keywords)]),
        ),
      },
      {
        id: "venue",
        name: "期刊",
        rows: group(items.map((p) => p.literature.metadata.venue ?? "未提供")),
      },
      {
        id: "state",
        name: "材料状态",
        rows: group(
          items.map((p) =>
            p.needs_manual_pdf
              ? "自动获取已耗尽"
              : p.literature.status === "CONTENT_READY"
                ? "内容已就绪"
                : p.literature.status === "ASSET_READY"
                  ? "有 PDF"
                  : "仅元数据",
          ),
        ),
      },
    ];
    const tables = new Set<string>();
    const render = () => {
      content.innerHTML = `<div class="cards">${groups
        .map((g) => {
          const rows = g.rows.slice(0, 12),
            max = rows[0]?.[1] ?? 1;
          return `<div class="ccard"><div class="chd"><h4>${g.name}</h4><button class="btn q sm" data-table="${g.id}">${tables.has(g.id) ? "图表" : "表格"}</button></div><div class="cs">当前范围 · ${items.length} 篇</div>${tables.has(g.id) ? `<table class="mini-t"><thead><tr><th>分类</th><th>篇数</th></tr></thead><tbody>${rows.map(([l, n]) => `<tr><td>${e(l)}</td><td>${n}</td></tr>`).join("")}</tbody></table>` : `<div class="hbars">${rows.map(([l, n]) => `<span class="l" title="${e(l)}">${e(l)}</span><button class="t" data-group="${g.id}" data-label="${e(l)}" title="${e(l)}：${n} 篇"><i style="width:${(n / max) * 100}%"></i></button><span class="n">${n}</span>`).join("")}</div>`}</div>`;
        })
        .join("")}</div>`;
      click(
        "[data-table]",
        (el) => {
          const id = el.dataset.table!;
          if (tables.has(id)) tables.delete(id);
          else tables.add(id);
          render();
        },
        content,
      );
      click(
        "[data-group]",
        (el) => {
          const label = el.dataset.label!;
          if (el.dataset.group === "year" && label !== "未提供")
            ctx.library.query = {
              ...ctx.library.query,
              publication_year_from: Number(label),
              publication_year_to: Number(label),
            };
          else if (el.dataset.group === "tag")
            ctx.library.query = { ...ctx.library.query, keywords: [label] };
          else if (el.dataset.group === "venue" && label !== "未提供")
            ctx.library.query = { ...ctx.library.query, venue: label };
          else return;
          ctx.navigate("lib");
        },
        content,
      );
    };
    render();
    click("#ins-stats", render, ctx.root);
    click(
      "#ins-cap",
      () =>
        capabilityMenu(
          ctx,
          items.map((p) => p.literature.literature_id),
        ),
      ctx.root,
    );
    click(
      "#ins-map",
      async () => {
        content.textContent = "正在读取当前范围的真实引用关系…";
        const selected = items.slice(0, 40),
          ids = new Set(selected.map((p) => p.literature.literature_id)),
          edges: [string, string][] = [];
        for (const p of selected) {
          const page = record(
            (
              await ctx.api.query(
                "references",
                {
                  literature_id: p.literature.literature_id,
                  direction: "references",
                  limit: 100,
                  cursor: null,
                },
                ctx.signal,
              )
            ).page,
            "references",
          );
          for (const raw of Array.isArray(page.items) ? page.items : []) {
            const ref = record(raw, "reference"),
              related = parseLiteratureSearchItem(ref.related_literature);
            if (ids.has(related.literature.literature_id))
              edges.push([
                p.literature.literature_id,
                related.literature.literature_id,
              ]);
          }
          if (ctx.signal.aborted) return;
        }
        const pos = new Map<string, { x: number; y: number }>(
          selected.map((p, i) => [
            p.literature.literature_id,
            {
              x: 360 + 270 * Math.cos((i / selected.length) * Math.PI * 2),
              y: 240 + 180 * Math.sin((i / selected.length) * Math.PI * 2),
            },
          ]),
        );
        content.innerHTML = `<p class="f2">当前范围前 ${selected.length} 篇的库内引用（每篇最多读取 100 条），${edges.length} 条已确认关系。点击节点打开文献。</p><svg class="network-map" viewBox="0 0 720 480" role="img" aria-label="库内引用网络">${edges.map(([a, b]) => `<line x1="${pos.get(a)!.x}" y1="${pos.get(a)!.y}" x2="${pos.get(b)!.x}" y2="${pos.get(b)!.y}" stroke="var(--line2)"/>`).join("")}${selected
          .map((p, i) => {
            const point = pos.get(p.literature.literature_id)!;
            return `<g data-paper="${e(p.literature.literature_id)}" tabindex="0" role="button" aria-label="${e(title(p))}"><circle cx="${point.x}" cy="${point.y}" r="7" fill="var(--blue)"/><text x="${point.x + 10}" y="${point.y + 4}" fill="var(--fg2)" font-size="11">${i + 1}</text><title>${e(title(p))}</title></g>`;
          })
          .join(
            "",
          )}</svg><div>${selected.map((p, i) => `<p><button class="lk" data-paper="${e(p.literature.literature_id)}">${i + 1}. ${e(title(p))}</button></p>`).join("")}</div>`;
        click(
          "[data-paper]",
          (el) => ctx.openPaper(el.dataset.paper!),
          content,
        );
      },
      ctx.root,
    );
  } catch (error) {
    if (!ctx.signal.aborted) failure(content, error, () => renderInsights(ctx));
  }
}
