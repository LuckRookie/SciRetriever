/* Icon paths from the approved prototype. */
const paths: Readonly<Record<string, string>> = {
  lib: '<path d="M4 3.5h3v13H4zM8.5 3.5h3v13h-3z"/><path d="M13 4.2l2.8-.8 2.7 12.4-2.8.7z"/>',
  disc: '<circle cx="10" cy="10" r="7"/><path d="M13.2 6.8l-1.7 4.7-4.7 1.7 1.7-4.7z"/>',
  ask: '<circle cx="9" cy="9" r="5.5"/><path d="M13 13l4 4"/>',
  syn: '<path d="M10 3l7 3.5-7 3.5-7-3.5z"/><path d="M3 10l7 3.5 7-3.5"/><path d="M3 13.5l7 3.5 7-3.5"/>',
  task: '<path d="M8 5.5h9M8 10h9M8 14.5h9"/><path d="M3 5.5l1 1 1.8-2M3 10l1 1 1.8-2"/><circle cx="4" cy="14.5" r="1"/>',
  web: '<rect x="2.5" y="3.5" width="15" height="11" rx="1.5"/><path d="M7 17h6"/>',
  set: '<circle cx="10" cy="10" r="2.5"/><path d="M10 2.5v2.2M10 15.3v2.2M2.5 10h2.2M15.3 10h2.2M4.7 4.7l1.6 1.6M13.7 13.7l1.6 1.6M4.7 15.3l1.6-1.6M13.7 6.3l1.6-1.6"/>',
  srch: '<circle cx="9" cy="9" r="5.5"/><path d="M13 13l4 4"/>',
  text: '<path d="M4 5h12M4 9h12M4 13h8"/>',
  person:
    '<circle cx="10" cy="7" r="3"/><path d="M4 17c1-3.5 3.5-5 6-5s5 1.5 6 5"/>',
  cal: '<rect x="3" y="4.5" width="14" height="12" rx="1.5"/><path d="M3 8.5h14M7 3v3M13 3v3"/>',
  book: '<path d="M4 4.5A1.5 1.5 0 015.5 3H16v12H5.5A1.5 1.5 0 004 16.5z"/><path d="M4 16.5A1.5 1.5 0 005.5 18H16"/>',
  stat: '<circle cx="10" cy="10" r="6.5"/><path d="M10 6.5V10l2.5 1.5"/>',
  link: '<path d="M8.5 11.5a3 3 0 004.2 0l2.5-2.5a3 3 0 00-4.2-4.2l-.8.8"/><path d="M11.5 8.5a3 3 0 00-4.2 0L4.8 11a3 3 0 004.2 4.2l.8-.8"/>',
  file: '<path d="M5 2.5h6.5L15 6v11.5H5z"/><path d="M11.5 2.5V6H15"/>',
  up: '<path d="M10 13V4M6.5 7.5L10 4l3.5 3.5M4 16h12"/>',
  open: '<path d="M8 4H4v12h12v-4"/><path d="M11 3h6v6M17 3l-8 8"/>',
  x: '<path d="M5 5l10 10M15 5L5 15"/>',
  plus: '<path d="M10 4v12M4 10h12"/>',
  db: '<ellipse cx="10" cy="5" rx="6" ry="2.5"/><path d="M4 5v10c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V5M4 10c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5"/>',
  bulb: '<path d="M7.5 14.5h5M8 17h4"/><path d="M10 2.5a5 5 0 00-3 9c.6.5 1 1.2 1 2h4c0-.8.4-1.5 1-2a5 5 0 00-3-9z"/>',
  ins: '<path d="M3 16.5h14"/><path d="M5.5 13.5V9M9 13.5V5M12.5 13.5v-6M16 13.5V3.5"/>',
  ext: '<rect x="3" y="3" width="14" height="14" rx="1.5"/><path d="M3 8h14M8 8v9"/>',
  spark:
    '<path d="M10 2.5l1.6 4.4 4.4 1.6-4.4 1.6L10 14.5l-1.6-4.4L4 8.5l4.4-1.6z"/><path d="M15.5 13.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"/>',
  tag: '<path d="M3 3h6.5L17 10.5 10.5 17 3 9.5z"/><circle cx="6.5" cy="6.5" r="1"/>',
};
export function icon(name: string, small = false): string {
  return `<svg class="i${small ? " s" : ""}" viewBox="0 0 20 20" aria-hidden="true">${paths[name] ?? paths.lib}</svg>`;
}
