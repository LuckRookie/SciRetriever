/**
 * The page's original data as the library takes it (`WebPageData`, product
 * interface 2.4.2; literature and materials 6.4.5): the address, the title,
 * every `meta` with a `name` or `property`, the schema.org JSON-LD text and
 * whether the page is itself a PDF. Nothing is interpreted here: the
 * library's `web-page` adapter reads the bibliography and the PDF address.
 */
export interface WebPageData {
  url: string;
  title: string | null;
  meta: { attribute: "name" | "property"; key: string; content: string }[];
  json_ld: string[];
  is_pdf: boolean;
}

/**
 * Collects the page's data within the contract's limits: at most 500 `meta`,
 * at most 5 JSON-LD blocks of 64 KiB each, 512 KiB in all. It is injected
 * into the page with `chrome.scripting.executeScript`, so everything it uses
 * is declared inside it.
 */
export function readPage(): WebPageData {
  const META = 500,
    BLOCKS = 5,
    BLOCK_BYTES = 64 * 1024,
    TOTAL_BYTES = 512 * 1024;
  const bytes = (value: unknown) =>
    new TextEncoder().encode(JSON.stringify(value)).byteLength;
  const meta: WebPageData["meta"] = [];
  for (const element of document.querySelectorAll(
    "meta[name], meta[property]",
  )) {
    if (meta.length >= META) break;
    const name = element.getAttribute("name");
    const attribute = name !== null ? "name" : "property";
    const key = name ?? element.getAttribute("property") ?? "";
    const content = element.getAttribute("content");
    if (!key || content === null) continue;
    meta.push({ attribute, key, content });
  }
  const json_ld: string[] = [];
  for (const script of document.querySelectorAll(
    'script[type="application/ld+json"]',
  )) {
    if (json_ld.length >= BLOCKS) break;
    const text = script.textContent ?? "";
    // A block over the limit is left out whole: a cut one is not JSON.
    if (text.trim() && new TextEncoder().encode(text).byteLength <= BLOCK_BYTES)
      json_ld.push(text);
  }
  const page: WebPageData = {
    url: location.href,
    title: document.title || null,
    meta,
    json_ld,
    is_pdf:
      document.contentType === "application/pdf" ||
      /\.pdf(?:$|[?#])/iu.test(location.pathname),
  };
  // Within 512 KiB: the JSON-LD goes first, from the last block, then `meta`.
  while (bytes(page) > TOTAL_BYTES && page.json_ld.length) page.json_ld.pop();
  while (bytes(page) > TOTAL_BYTES && page.meta.length) page.meta.pop();
  return page;
}
