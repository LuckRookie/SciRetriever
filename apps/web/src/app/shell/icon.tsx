const paths: Record<string, string> = {
  lib: "M4 4v16M8 4v16M13 5l4-1 4 15-4 1zM3 8h6M3 16h6",
  disc: "m12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6Z",
  ins: "M4 20V4M4 20h17M8 16v-4M13 16V7M18 16v-7",
  ask: "M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  syn: "M4 5h6v5H4zM14 5h6v5h-6zM9 16h6v5H9zM7 10v3h10v-3M12 13v3",
  ext: "M4 4h16v16H4zM4 10h16M10 4v16",
  task: "m3 6 2 2 3-4M11 6h10m-18 6 2 2 3-4M11 12h10M3 19h5m3 0h10",
  web: "M3 4h18v16H3zM3 9h18M7 6.5h.01M10 6.5h.01",
  set: "M4 7h4m6 0h6M4 17h10m6 0h0M14 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0M20 17a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  close: "m6 6 12 12M6 18 18 6",
  menu: "M4 6h16M4 12h16M4 18h16",
  activity: "M3 12h4l3-8 4 16 3-8h4",
  file: "M14 3H5v18h14V8zm0 0v5h5M9 12h6M9 16h6",
  refresh: "M20 8a8 8 0 0 0-14-2L3 9m0-5v5h5M4 16a8 8 0 0 0 14 2l3-3m0 5v-5h-5",
};
export function Icon({ name }: { name: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] ?? paths.file} />
    </svg>
  );
}
