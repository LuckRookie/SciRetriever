/**
 * Synthetic Zotero Web API v3 objects for the `zotero-api` adapter. Ported from
 * the plan 28 block 14 probe generator (sandbox/cases/2026-11-09-zotero-probe/
 * make-fixtures.py): shapes follow the 2026-11-10 probe of a public library,
 * every name, title and key is invented. Annotation shapes follow Zotero's
 * schema and are unverified. Additions: a trashed item, a stored snapshot.
 */
type Json = Record<string, unknown>;
export const USER = 1000001,
  GROUP = 2000001;
const V = 120;
const library = (type: "user" | "group", id: number, name: string) => ({
  type,
  id,
  name,
  links: {
    alternate: {
      href: `https://www.zotero.org/${type === "group" ? "groups/" : ""}${id}`,
      type: "text/html",
    },
  },
});
const UL = library("user", USER, "synthetic-user"),
  GL = library("group", GROUP, "synthetic-group");
const B = `/users/${USER}`,
  GB = `/groups/${GROUP}`;
function links(
  base: string,
  key: string,
  extra: { up?: string; attachment?: Json; enclosure?: Json } = {},
) {
  return {
    self: {
      href: `https://api.zotero.org${base}/items/${key}`,
      type: "application/json",
    },
    alternate: {
      href: `https://www.zotero.org/x/items/${key}`,
      type: "text/html",
    },
    ...(extra.up
      ? {
          up: {
            href: `https://api.zotero.org${base}/items/${extra.up}`,
            type: "application/json",
          },
        }
      : {}),
    ...(extra.attachment ? { attachment: extra.attachment } : {}),
    ...(extra.enclosure ? { enclosure: extra.enclosure } : {}),
  };
}
function top(
  key: string,
  data: Json,
  csl: Json,
  numChildren: number,
  attachment?: Json,
  L: Json = UL,
  base = B,
) {
  return {
    key,
    version: V,
    library: L,
    links: links(base, key, attachment ? { attachment } : {}),
    meta: { numChildren },
    csljson: { id: `${L.id}/${key}`, ...csl },
    data: {
      key,
      version: V,
      dateAdded: "2026-01-05T08:00:00Z",
      dateModified: "2026-02-01T08:00:00Z",
      relations: {},
      ...data,
    },
  };
}
function child(
  key: string,
  parent: string | null,
  data: Json,
  enclosure?: Json,
  L: Json = UL,
  base = B,
) {
  return {
    key,
    version: V,
    library: L,
    links: links(base, key, {
      ...(parent ? { up: parent } : {}),
      ...(enclosure ? { enclosure } : {}),
    }),
    meta: {},
    data: {
      key,
      version: V,
      ...(parent ? { parentItem: parent } : {}),
      tags: [],
      relations: {},
      dateAdded: "2026-01-05T08:00:00Z",
      dateModified: "2026-01-05T08:00:00Z",
      ...data,
    },
  };
}
const author = (lastName: string, firstName: string) => ({
  creatorType: "author",
  firstName,
  lastName,
});
export const A = top(
  "AAAA0001",
  {
    itemType: "journalArticle",
    title: "Synthetic tetrazole salt A",
    creators: [author("Lin", "Yue"), author("Okafor", "Ada")],
    publicationTitle: "Synthetic Journal of Energetic Materials",
    date: "2024-03",
    DOI: "10.5555/synth.0001",
    extra: "",
    collections: ["COLL0002", "COLL0003"],
    tags: [{ tag: "tetrazole" }, { tag: "Crystal structure", type: 1 }],
  },
  {
    type: "article-journal",
    title: "Synthetic tetrazole salt A",
    author: [
      { family: "Lin", given: "Yue" },
      { family: "Okafor", given: "Ada" },
    ],
    "container-title": "Synthetic Journal of Energetic Materials",
    issued: { "date-parts": [[2024, 3]] },
    DOI: "10.5555/synth.0001",
  },
  3,
  {
    href: `https://api.zotero.org${B}/items/PDFA0001`,
    type: "application/json",
    attachmentType: "application/pdf",
    attachmentSize: 482113,
  },
);
/** The probe's CSL had a string year; the CSL rules refuse it, so Zotero fields are used. */
export const PREPRINT = top(
  "BBBB0002",
  {
    itemType: "preprint",
    title: "Synthetic furazan preprint B",
    creators: [author("Novak", "Petr")],
    repository: "arXiv",
    date: "2025",
    DOI: "",
    extra: "arXiv: 2501.01234",
    url: "https://arxiv.org/abs/2501.01234",
    collections: ["COLL0001"],
    tags: [],
  },
  {
    type: "article",
    title: "Synthetic furazan preprint B",
    author: [{ family: "Novak", given: "Petr" }],
    issued: { "date-parts": [["2025"]] },
    number: "arXiv:2501.01234",
    URL: "https://arxiv.org/abs/2501.01234",
  },
  1,
);
export const BOOK = top(
  "CCCC0003",
  {
    itemType: "book",
    title: "Synthetic handbook C",
    creators: [author("Ramos", "Ines")],
    publisher: "Synthetic Press",
    date: "2019",
    extra: "DOI: 10.5555/synth.book.0003\nOriginal Date: 2018\nPMID: 31234567",
    collections: [],
    tags: [{ tag: "handbook", type: 1 }],
  },
  {
    type: "book",
    title: "Synthetic handbook C",
    author: [{ family: "Ramos", given: "Ines" }],
    publisher: "Synthetic Press",
    issued: { "date-parts": [[2019]] },
  },
  0,
);
export const REPORT = top(
  "EEEE0005",
  {
    itemType: "report",
    title: "Synthetic report without identifiers E",
    creators: [author("Chen", "Wei")],
    institution: "Synthetic Lab",
    date: "2021",
    extra: "",
    collections: ["COLL0001"],
    tags: [],
  },
  {
    type: "report",
    title: "Synthetic report without identifiers E",
    author: [{ family: "Chen", given: "Wei" }],
    publisher: "Synthetic Lab",
    issued: { "date-parts": [[2021]] },
  },
  2,
);
export const TRASHED = top(
  "TRSH0001",
  {
    itemType: "journalArticle",
    title: "Synthetic trashed article",
    creators: [],
    deleted: 1,
    collections: [],
    tags: [],
  },
  { type: "article-journal", title: "Synthetic trashed article" },
  1,
);
export const PDF_A = child(
  "PDFA0001",
  "AAAA0001",
  {
    itemType: "attachment",
    linkMode: "imported_file",
    title: "Full Text PDF",
    contentType: "application/pdf",
    filename: "Lin 2024 synthetic.pdf",
    md5: "0f343b0931126a20f133d67c2b018a3b",
    mtime: 1767600000000,
  },
  {
    type: "application/pdf",
    href: `https://api.zotero.org${B}/items/PDFA0001/file/view`,
    title: "Lin 2024 synthetic.pdf",
    length: 482113,
  },
);
export const PDF_A2 = child(
  "PDFA0002",
  "AAAA0001",
  {
    itemType: "attachment",
    linkMode: "imported_url",
    title: "Supporting Information",
    contentType: "application/pdf",
    filename: "si.pdf",
    md5: "5d41402abc4b2a76b9719d911017c592",
    url: "https://example.org/si.pdf",
  },
  {
    type: "application/pdf",
    href: `https://api.zotero.org${B}/items/PDFA0002/file/view`,
    title: "si.pdf",
  },
);
export const NOTE_A = child("NOTEA003", "AAAA0001", {
  itemType: "note",
  note: "<p>synthetic note</p>",
});
export const LINKED_B = child("LINKB001", "BBBB0002", {
  itemType: "attachment",
  linkMode: "linked_file",
  title: "Preprint PDF",
  contentType: "application/pdf",
  path: "attachments:Novak/2501.01234.pdf",
});
export const URL_E = child("URLE0001", "EEEE0005", {
  itemType: "attachment",
  linkMode: "linked_url",
  title: "Landing page",
  contentType: "text/html",
  url: "https://example.org/report-e",
});
export const SNAPSHOT_E = child("SNAPE001", "EEEE0005", {
  itemType: "attachment",
  linkMode: "imported_url",
  title: "Snapshot",
  contentType: "text/html",
  filename: "snapshot.html",
  md5: "6f1ed002ab5595859014ebf0951522d9",
});
export const TRASHED_PDF = child("TRSHPDF1", "TRSH0001", {
  itemType: "attachment",
  linkMode: "imported_file",
  contentType: "application/pdf",
  filename: "trashed.pdf",
});
export const STANDALONE = child("SOLO0001", null, {
  itemType: "attachment",
  linkMode: "imported_file",
  title: "untitled scan.pdf",
  contentType: "application/pdf",
  filename: "untitled scan.pdf",
  md5: "7d793037a0760186574b0282f2f435e7",
  collections: [],
});
export const annotation = (
  key: string,
  type: string,
  position: Json,
  extra: Json = {},
  parent = "PDFA0001",
) =>
  child(key, parent, {
    itemType: "annotation",
    annotationType: type,
    annotationText: "",
    annotationComment: "",
    annotationColor: "#ffd400",
    annotationPageLabel: "3",
    annotationPosition: JSON.stringify(position),
    ...extra,
  });
export const ANNOTATIONS = [
  annotation(
    "ANNO0001",
    "highlight",
    { pageIndex: 2, rects: [[72, 640.2, 300.5, 652]] },
    {
      annotationText: "synthetic highlighted sentence",
      annotationComment: "check density",
    },
  ),
  annotation(
    "ANNO0002",
    "underline",
    { pageIndex: 2, rects: [[310, 500, 420, 511.5]] },
    {
      annotationText: "synthetic underlined phrase",
      annotationColor: "#2ea8e5",
    },
  ),
  annotation(
    "ANNO0003",
    "image",
    { pageIndex: 4, rects: [[90, 300, 400, 520]] },
    { annotationColor: "#a28ae5" },
  ),
  annotation("ANNO0004", "note", {
    pageIndex: 0,
    rects: [[500, 700, 522, 722]],
  }),
  annotation("ANNO0005", "ink", {
    pageIndex: 1,
    width: 2,
    paths: [[100, 100, 110, 112]],
  }),
];
export const GROUP_ITEM = top(
  "GGGG0001",
  {
    itemType: "journalArticle",
    title: "Synthetic group article G",
    creators: [author("Silva", "Rui")],
    publicationTitle: "Synthetic Letters",
    date: "2023",
    DOI: "10.5555/synth.group.0001",
    extra: "",
    collections: ["GCOL0001"],
    tags: [{ tag: "shared" }],
  },
  {
    type: "article-journal",
    title: "Synthetic group article G",
    author: [{ family: "Silva", given: "Rui" }],
    issued: { "date-parts": [[2023]] },
    DOI: "10.5555/synth.group.0001",
  },
  0,
  undefined,
  GL,
  GB,
);
const collection = (
  key: string,
  name: string,
  parent: string | false,
  L: Json = UL,
) => ({
  key,
  version: V,
  library: L,
  meta: {},
  data: { key, version: V, name, parentCollection: parent, relations: {} },
});
export const COLLECTIONS = [
  collection("COLL0001", "Energetic materials", false),
  collection("COLL0002", "Tetrazoles", "COLL0001"),
  collection("COLL0003", "Reviews", false),
];
export const GROUP_COLLECTIONS = [
  collection("GCOL0001", "Shared reading", false, GL),
];
/** `/items` of the user library in one segment, as a carrier sends it. */
export const USER_ITEMS = [
  A,
  PREPRINT,
  BOOK,
  REPORT,
  TRASHED,
  PDF_A,
  PDF_A2,
  NOTE_A,
  LINKED_B,
  URL_E,
  SNAPSHOT_E,
  TRASHED_PDF,
  STANDALONE,
  ...ANNOTATIONS,
];
