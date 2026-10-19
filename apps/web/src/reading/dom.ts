import type { ReaderFrame } from "./contract.js";
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
          host.textContent =
            error instanceof Error ? error.message : "阅读操作未完成";
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
  frame.status.textContent = text;
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
