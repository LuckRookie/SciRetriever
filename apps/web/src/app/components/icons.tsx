import type { SVGProps } from "react";
export type IconName =
  | "search"
  | "close"
  | "chevron"
  | "check"
  | "plus"
  | "minus"
  | "copy"
  | "external"
  | "menu"
  | "more"
  | "refresh"
  | "book"
  | "activity"
  | "settings"
  | "file"
  | "arrow"
  | "download"
  | "upload"
  | "spark"
  | "warning"
  | "eye"
  | "filter"
  | "sort"
  | "folder"
  | "clock"
  | "pointer"
  | "highlighter"
  | "region"
  | "note"
  | "translate"
  | "trash";
const paths: Record<IconName, string> = {
  search: "m16 16 5 5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  close: "m6 6 12 12 M18 6 6 18",
  chevron: "m6 9 6 6 6-6",
  check: "m5 12 4 4L19 6",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  copy: "M9 9h11v12H9z M15 5V2H3v14h2",
  external: "M14 3h7v7M21 3 10 14 M10 3H3v18h18v-7",
  menu: "M4 6h16M4 12h16M4 18h16",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  refresh: "M20 8a8 8 0 1 0 0 8M20 3v5h-5",
  book: "M12 5C9 3 5 3 2 4v16c3-1 7-1 10 1 3-2 7-2 10-1V4c-3-1-7-1-10 1v16",
  activity: "M2 12h4l3-8 5 16 3-8h5",
  settings:
    "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M9 2h6l1 4 4 1 2 5-3 3v4l-5 3-3-3-4 1-4-5 2-3-1-4 5-2z",
  file: "M14 2H4v20h16V8z M14 2v6h6 M8 13h8M8 17h6",
  arrow: "M4 12h16m-6-6 6 6-6 6",
  download: "M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5",
  upload: "M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5",
  spark: "m12 3 2.8 6.2L21 12l-6.2 2.8L12 21l-2.8-6.2L3 12l6.2-2.8z",
  warning: "m12 3 10 18H2zM12 9v5M12 17h.01",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12 M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  filter: "M4 6h16M7 12h10M10 18h4",
  sort: "M7 4v16m0 0-3-3m3 3 3-3M17 20V4m0 0-3 3m3-3 3 3",
  folder:
    "M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z",
  clock: "M12 7v5l3 2 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
  pointer: "M5 3.5 19 10.5l-6 1.5-3 6z",
  highlighter: "M14.5 4 20 9.5l-9 9H5.5V13z M12.5 6l5.5 5.5 M3 21h7",
  region: "M4 8V4h4 M16 4h4v4 M20 16v4h-4 M8 20H4v-4 M10 10h4v4h-4z",
  note: "M4 4h16v11H11l-5 4v-4H4z",
  translate:
    "M3 5h10 M8 3v2 M5 9c1.5 3 4 5 7 6 M11 5c-1 4.5-3.5 8-7 10 M13 21l4-9 4 9 M14.3 18h5.4",
  trash: "M4 7h16 M10 7V4h4v3 M6 7l1 13h10l1-13",
};
export function Icon({
  name,
  ...props
}: SVGProps<SVGSVGElement> & { name: IconName }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d={paths[name]} />
    </svg>
  );
}
