import { parseDiscoveryRunId } from "@sciretriever/contracts";
import { record, type JsonRecord } from "../wire.js";
import { escape as e, node, click, message, toast, button } from "./dom.js";
import type { AppContext } from "./types.js";
const reports: { name: string; report: JsonRecord }[] = [];
export async function renderIntake(ctx: AppContext): Promise<void> {
  ctx.root.innerHTML = `<div class="pg"><div class="pgin"><h1 class="ptitle">发现</h1><p class="pdesc">发现与导入文献。接纳元数据后，可在库中另行选择获取或加工。</p><div class="composer"><div class="ctabs">${[
    ["topic", "主题发现"],
    ["cite", "引用扩展"],
    ["bib", "导入书目"],
    ["pdf", "上传 PDF"],
  ]
    .map(
      ([k, l]) =>
        `<button class="vt ${k === "topic" ? "on" : ""}" data-dm="${k}">${l}</button>`,
    )
    .join(
      "",
    )}</div><div id="intake-form"></div></div><p id="intake-status" role="status"></p><h3 class="h">本次会话的运行结果</h3><div id="intake-reports"></div></div></div>`;
  const renderReports = () => {
    node("#intake-reports", ctx.root).innerHTML =
      reports
        .map(
          (r, i) =>
            `<details class="tg"><summary>${e(r.name)}</summary><pre>${e(JSON.stringify(r.report, null, 2))}</pre>${typeof r.report.discovery_run_id === "string" ? `<button class="btn sm" data-batch="${i}">在文献库查看本次发现</button>` : ""}</details>`,
        )
        .join("") || '<p class="f3">尚未执行发现或导入。</p>';
    click(
      "[data-batch]",
      (el) => {
        const report = reports[Number(el.dataset.batch)]!.report;
        ctx.library.query = {
          ...ctx.library.query,
          discovery_run_ids: [parseDiscoveryRunId(report.discovery_run_id)],
        };
        ctx.navigate("lib");
      },
      ctx.root,
    );
  };
  let mode = "topic",
    busy = false;
  const renderForm = () => {
    const form = node("#intake-form", ctx.root);
    form.innerHTML = `<form class="filter-grid" id="discovery-form">${mode === "topic" ? '<label>主题或检索式<input name="query" id="discovery-query" required maxlength="8192" placeholder="输入研究主题或检索式"></label><label>逐来源扫描上限<input name="limit" id="discovery-limit" type="number" value="200" min="1" max="10000" required></label><label>年份起<input name="from" type="number" min="1" max="9999"></label><label>年份止<input name="to" type="number" min="1" max="9999"></label>' : mode === "cite" ? '<label>种子文献 ID<input name="seed" required placeholder="从文献库复制 Literature ID"></label><label>方向<select name="direction"><option value="references">参考文献</option><option value="cited-by">被引文献</option></select></label><label>扫描上限<input name="limit" type="number" value="100" min="1" max="10000"></label>' : mode === "bib" ? '<label>书目文件<input type="file" name="file" id="bibliography-file" accept=".bib,.ris,.json" required></label><label>格式<select name="format" id="bibliography-format"><option value="bibtex">BibTeX</option><option value="biblatex">BibLaTeX</option><option value="ris">RIS</option><option value="csl-json">CSL JSON</option></select></label>' : '<label>目标文献 ID<input name="literature" required></label><label>PDF 文件<input type="file" name="file" accept="application/pdf" required></label>'}<button type="submit" class="btn blue">${mode === "bib" ? "导入" : mode === "pdf" ? "选择并上传" : "开始发现"}</button></form>`;
    node<HTMLFormElement>("#discovery-form", form).onsubmit = (event) => {
      event.preventDefault();
      if (busy) return;
      const data = new FormData(event.currentTarget as HTMLFormElement),
        selectedMode = mode;
      busy = true;
      const controls = Array.from(
        form.querySelectorAll<
          HTMLInputElement | HTMLButtonElement | HTMLSelectElement
        >("input,button,select"),
      );
      controls.forEach((c) => (c.disabled = true));
      const status = node("#intake-status", ctx.root);
      status.textContent = "正在执行，请保留页面以查看结果…";
      void (async () => {
        if (selectedMode === "pdf") {
          const file = data.get("file");
          if (!(file instanceof File)) throw new Error("请选择文件");
          await ctx.upload(String(data.get("literature")).trim(), file);
          status.textContent = "上传操作已结束";
          return;
        }
        let response: JsonRecord;
        if (selectedMode === "bib") {
          const file = data.get("file");
          if (
            !(file instanceof File) ||
            file.size < 1 ||
            file.size > 768 * 1024
          )
            throw new Error("请选择不超过 768 KiB 的书目文件");
          response = await ctx.api.request("/api/import", {
            format: data.get("format"),
            content: await file.text(),
          });
        } else
          response = await ctx.api.request(
            "/api/discovery",
            selectedMode === "cite"
              ? {
                  kind: "citation",
                  seed_literature_id: String(data.get("seed")).trim(),
                  direction: data.get("direction"),
                  scan_limit: Number(data.get("limit")),
                }
              : {
                  query: String(data.get("query")).trim(),
                  scan_limit: Number(data.get("limit")),
                  year_from: data.get("from") ? Number(data.get("from")) : null,
                  year_to: data.get("to") ? Number(data.get("to")) : null,
                },
          );
        const report = record(response.report, "run report");
        reports.unshift({
          name: `${selectedMode === "bib" ? "书目导入" : selectedMode === "cite" ? "引用扩展" : "主题发现"} · ${new Date().toLocaleTimeString()}`,
          report,
        });
        if (reports.length > 30) reports.pop();
        status.textContent =
          "操作已结束，逐项结果见下方报告。未自动启动 PDF 获取。";
        status.append(button("查看文献库", () => ctx.navigate("lib")));
        renderReports();
        ctx.updateNavigation();
      })()
        .catch((error) => {
          status.textContent = `操作未完成：${message(error)}`;
        })
        .finally(() => {
          busy = false;
          controls.forEach((c) => (c.disabled = false));
        });
    };
  };
  click(
    "[data-dm]",
    (el) => {
      if (busy) {
        toast("请等待当前操作结束");
        return;
      }
      mode = el.dataset.dm!;
      for (const tab of ctx.root.querySelectorAll("[data-dm]"))
        tab.classList.toggle("on", tab === el);
      renderForm();
    },
    ctx.root,
  );
  renderForm();
  renderReports();
}
