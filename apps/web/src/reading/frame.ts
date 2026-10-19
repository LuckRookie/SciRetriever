import { node, button } from "../workspace/dom.js";
import type { AppContext, ReaderMode } from "../workspace/types.js";
import type { ReadingPosition } from "./state.js";

export interface ReaderFrame {
  body: HTMLElement;
  controls: HTMLElement;
  outline: HTMLElement;
  status: HTMLElement;
  findStatus: HTMLElement;
  onFind: (query: string) => void | Promise<void>;
  beforeLayout: () => () => void;
}
export function readingFrame(
  ctx: AppContext,
  state: ReadingPosition,
  mode: ReaderMode,
): ReaderFrame {
  const root = ctx.root,
    shell = node(".reader", root),
    viewer = node(".viewer", root),
    body = node("#reader-body", root),
    status = node("#reader-status", root),
    information = node(".rside", root);
  shell.classList.add("reader-workspace");
  viewer.classList.add("reading-view");
  body.classList.add("reading-scroll");
  information.classList.add("reading-info");
  const toolbar = document.createElement("div");
  toolbar.className = "reading-toolbar";
  toolbar.innerHTML =
    '<button class="btn q sm" id="reader-outline-toggle">目录</button><div class="reading-controls" id="reader-mode-controls"></div><span class="reading-spacer"></span><button class="btn q sm" id="reader-find-toggle" disabled>查找</button><button class="btn q sm" id="reader-info-toggle">收起信息</button>';
  const find = document.createElement("form");
  find.className = "reading-toolbar";
  find.id = "reader-find-bar";
  find.hidden = true;
  find.innerHTML =
    '<input type="search" id="reader-find-query" aria-label="文档内查找" placeholder="输入原文关键词"><button class="btn" type="submit">查找</button><span id="reader-find-status" role="status"></span>';
  const frame = document.createElement("div");
  frame.className = "reading-frame";
  const outline = document.createElement("nav");
  outline.className = "reading-outline library-reading-sections";
  outline.id = "reader-outline";
  outline.setAttribute("aria-label", "文档目录");
  body.before(frame);
  frame.append(outline, body);
  viewer.prepend(toolbar, find);
  viewer.append(status);
  status.className = "reading-status";
  const result: ReaderFrame = {
    body,
    controls: node("#reader-mode-controls", toolbar),
    outline,
    status,
    findStatus: node("#reader-find-status", find),
    onFind: () => {},
    beforeLayout: () => () => {},
  };
  const apply = () => {
    outline.hidden = !state.outline;
    information.hidden = !state.information;
    shell.classList.toggle("reading-no-info", !state.information);
    body.style.setProperty("--reading-font-size", `${state.fontSize}px`);
    body.classList.toggle("reading-wide", state.wide);
    node("#reader-outline-toggle", toolbar).setAttribute(
      "aria-expanded",
      String(state.outline),
    );
    node("#reader-info-toggle", toolbar).textContent = state.information
      ? "收起信息"
      : "显示信息";
    node("#reader-info-toggle", toolbar).setAttribute(
      "aria-expanded",
      String(state.information),
    );
  };
  const changeLayout = (change: () => void) => {
    const restore = result.beforeLayout();
    change();
    apply();
    requestAnimationFrame(() => {
      if (!ctx.signal.aborted) restore();
    });
  };
  node("#reader-outline-toggle", toolbar).onclick = () =>
    changeLayout(() => {
      state.outline = !state.outline;
    });
  node("#reader-info-toggle", toolbar).onclick = () =>
    changeLayout(() => {
      state.information = !state.information;
    });
  const input = node<HTMLInputElement>("#reader-find-query", find);
  input.value = state.query;
  input.oninput = () => {
    state.query = input.value;
  };
  node("#reader-find-toggle", toolbar).onclick = () => {
    find.hidden = !find.hidden;
    if (!find.hidden) input.focus();
  };
  find.onsubmit = (event) => {
    event.preventDefault();
    const query = input.value.trim();
    state.query = input.value;
    if (!query) {
      result.findStatus.textContent = "请输入原文关键词。";
      return;
    }
    void Promise.resolve(result.onFind(query)).catch((error) => {
      if (!ctx.signal.aborted)
        result.findStatus.textContent =
          error instanceof Error ? error.message : "查找未完成";
    });
  };
  if (mode !== "pdf") {
    result.controls.innerHTML =
      '<select id="reader-font-size" aria-label="阅读字号"><option value="18">18 px</option><option value="20">20 px</option><option value="22">22 px</option><option value="24">24 px</option></select><select id="reader-measure" aria-label="阅读行宽"><option value="comfortable">舒适行宽</option><option value="wide">展开行宽</option></select>';
    const font = node<HTMLSelectElement>("#reader-font-size", result.controls),
      width = node<HTMLSelectElement>("#reader-measure", result.controls);
    font.value = String(state.fontSize);
    width.value = state.wide ? "wide" : "comfortable";
    font.onchange = () =>
      changeLayout(() => {
        state.fontSize = Number(font.value);
      });
    width.onchange = () =>
      changeLayout(() => {
        state.wide = width.value === "wide";
      });
  }
  apply();
  return result;
}
export function verifiedDownload(
  ctx: AppContext,
  frame: ReaderFrame,
  bytes: Uint8Array<ArrayBuffer>,
  name: string,
): void {
  const url = URL.createObjectURL(
    new Blob([bytes], { type: "application/pdf" }),
  );
  const link = document.createElement("a");
  link.className = "btn q sm";
  link.href = url;
  link.download = name;
  link.textContent = "下载已核验的原始 PDF";
  frame.controls.append(link);
  ctx.signal.addEventListener("abort", () => URL.revokeObjectURL(url), {
    once: true,
  });
}
export function readerProblem(
  frame: ReaderFrame,
  text: string,
  retry?: () => void,
): void {
  frame.status.textContent = text;
  const note = document.createElement("p");
  note.className = "reading-notice";
  note.textContent = text;
  frame.body.append(note);
  if (retry) note.append(button("重试", retry));
}
