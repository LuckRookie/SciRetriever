import type { ReaderFrame } from "./contract.js";
/** Preserve reader-owned Chinese diagnostics; never display raw transport errors. */
export function readerErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && /[\u3400-\u9fff]/u.test(error.message)
    ? error.message
    : fallback;
}
export function node<T extends HTMLElement = HTMLElement>(
  selector: string,
  root: ParentNode,
): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Missing reader element: ${selector}`);
  return element;
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
/** Resource paths remain machine-readable; pending images never expose them as body text. */
export function imagePlaceholder(reference: string, label: string): string {
  return `<span class="reading-resource" data-resource="${escape(reference)}" data-resource-label="${escape(label)}">图片待加载</span>`;
}
/** Native controls are only used by the framework-neutral fallback host. */
export function button(
  label: string,
  action: () => void | Promise<void>,
): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "btn q sm";
  element.textContent = label;
  element.onclick = () => {
    if (element.disabled) return;
    element.disabled = true;
    void Promise.resolve()
      .then(action)
      .catch((error: unknown) => {
        const host = element
          .closest(".reader-workspace")
          ?.querySelector(".reading-status");
        if (host)
          host.textContent = readerErrorMessage(
            error,
            "阅读操作未完成，请重试；已读内容保留。",
          );
      })
      .finally(() => {
        element.disabled = false;
      });
  };
  return element;
}
export function readerProblem(
  frame: ReaderFrame,
  text: string,
  retry?: () => void,
): void {
  if (frame.onIssue) {
    frame.onIssue(text, retry);
    return;
  }
  const note = document.createElement("p");
  note.className = "reading-notice";
  note.textContent = text;
  frame.body.append(note);
  if (retry) note.append(button("重试", retry));
}
