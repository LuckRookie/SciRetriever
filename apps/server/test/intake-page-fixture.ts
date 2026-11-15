import type { LiteratureMetadata, WebPageData } from "@sciretriever/contracts";
/** Emits original synthetic browser tags; metadata remains a convenient fixture authoring input only. */
export function syntheticPage(
  metadata: Partial<LiteratureMetadata> = {},
): WebPageData {
  const values: [string, string][] = [];
  const add = (key: string, value: string | number | null | undefined) => {
    if (value !== null && value !== undefined)
      values.push([key, String(value)]);
  };
  add("citation_title", metadata.title);
  for (const author of metadata.authors ?? [])
    add("citation_author", author.display_name);
  for (const id of metadata.identifiers ?? [])
    add(
      id.namespace === "arxiv" ? "citation_arxiv_id" : "citation_doi",
      id.value,
    );
  add("citation_keywords", metadata.keywords?.join("; "));
  add("citation_abstract", metadata.abstract);
  add("citation_publication_date", metadata.publication_year);
  return {
    url: "https://synthetic.invalid/article",
    title: null,
    meta: values.map(([key, content]) => ({ attribute: "name", key, content })),
    json_ld: [],
    is_pdf: false,
  };
}
export function syntheticCaptureRequest(value: unknown): unknown {
  if (!value || typeof value !== "object" || !("metadata" in value))
    return value;
  const { metadata, ...rest } = value;
  const record = rest as {
    file?: { file_name: string; size_bytes?: number; sha256?: string };
  };
  return {
    ...rest,
    page: syntheticPage(metadata as Partial<LiteratureMetadata>),
    ...(record.file
      ? {
          file: {
            ...record.file,
            source_url: "https://synthetic.invalid/download/paper.pdf",
          },
        }
      : {}),
  };
}
