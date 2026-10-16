import { icon } from "./icons.js";
export { icon };
export function node<T extends HTMLElement = HTMLElement>(
  selector: string,
  root: ParentNode = document,
): T {
  const value = root.querySelector<T>(selector);
  if (!value) throw new Error(`Missing interface element: ${selector}`);
  return value;
}
export function all<T extends HTMLElement = HTMLElement>(
  selector: string,
  root: ParentNode = document,
): T[] {
  return [...root.querySelectorAll<T>(selector)];
}
export function escape(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}
export function message(error: unknown): string {
  return error instanceof Error ? error.message : "操作未完成";
}
let timer: ReturnType<typeof setTimeout> | undefined;
export function toast(text: string): void {
  let el = document.querySelector<HTMLElement>(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    el.setAttribute("role", "status");
    document.body.append(el);
  }
  el.textContent = text;
  clearTimeout(timer);
  timer = setTimeout(() => el.remove(), 7000);
}
export function click(
  selector: string,
  action: (element: HTMLElement) => void | Promise<void>,
  root: ParentNode = document,
): void {
  for (const element of all(selector, root))
    element.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void Promise.resolve()
        .then(() => action(element))
        .catch((error) => toast(message(error)));
    });
}
export function button(
  label: string,
  action: () => void | Promise<void>,
  primary = false,
): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = `btn ${primary ? "blue" : "q"} sm`;
  el.textContent = label;
  el.onclick = () => {
    if (el.disabled) return;
    el.disabled = true;
    void Promise.resolve()
      .then(action)
      .catch((error) => toast(message(error)))
      .finally(() => {
        el.disabled = false;
      });
  };
  return el;
}
export function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob),
    link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
export function failure(
  root: HTMLElement,
  error: unknown,
  retry?: () => void | Promise<void>,
): void {
  root.innerHTML = `<div class="empty" role="alert"><b>暂时无法读取</b><p>${escape(message(error))}</p></div>`;
  if (retry) node(".empty", root).append(button("重试", retry));
}

/** Keep a pending write visible until its acknowledgement is received. */
export function overlayBusy(): boolean {
  return (
    document.querySelector<HTMLElement>("#overlay")?.dataset.busy === "true"
  );
}
export function dismissOverlay(): boolean {
  if (overlayBusy()) {
    toast("正在等待操作回执，请稍候。");
    return false;
  }
  const overlay = node("#overlay");
  overlay.dispatchEvent(new Event("dismiss"));
  overlay.replaceChildren();
  return true;
}
