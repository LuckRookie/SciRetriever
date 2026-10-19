/** getRandomValues remains available on plain HTTP; randomUUID does not. */
export function randomId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Keep the explicit copy action usable on an operator's HTTP workbench. */
export async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      /* Try the browser's user-initiated selection copy below. */
    }
  }
  const previous = document.activeElement;
  const input = document.createElement("textarea");
  input.value = value;
  input.className = "clipboard-copy-source";
  input.setAttribute("aria-label", "待复制的上下文");
  document.body.append(input);
  try {
    input.select();
    if (!document.execCommand("copy"))
      throw new Error("浏览器未允许复制，请使用 JSON 导出保存上下文。");
  } finally {
    input.remove();
    if (previous instanceof HTMLElement)
      previous.focus({ preventScroll: true });
  }
}
