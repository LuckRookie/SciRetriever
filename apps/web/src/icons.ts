const paths: Record<string, string> = {
  library: '<path d="M4 4v16M8 4v16M13 5l4-1 4 15-4 1zM3 8h6M3 16h6"/>',
  browser:
    '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M7 6.5h.01M10 6.5h.01"/>',
  document:
    '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8zM14 3v5h5M9 12h6M9 16h6"/>',
  shield:
    '<path d="m12 3 8 3v6c0 4-5 8-8 9-3-1-8-5-8-9V6zM8.5 12l2.5 2.5 4.5-5"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 .5c0 1.5-2.5 2-2.5 3.5M12 17h.01"/>',
  refresh:
    '<path d="M20 8a8 8 0 0 0-14-2L3 9m0-5v5h5M4 16a8 8 0 0 0 14 2l3-3m0 5v-5h-5"/>',
  globe:
    '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4M12 14v3"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4"/>',
  cursor: '<path d="m5 3 14 10-7 1-3 7z"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  play: '<path d="m8 4 12 8-12 8z"/>',
  pause: '<path d="M8 4v16M16 4v16"/>',
  scan: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M7 9h10M7 13h7M7 17h4"/>',
  arrow: '<path d="M4 12h15m-5-5 5 5-5 5"/>',
  expand: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  sliders:
    '<path d="M4 7h4m6 0h6M4 17h10m6 0h0"/><circle cx="11" cy="7" r="3"/><circle cx="17" cy="17" r="3"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
};

export function renderIcons(root: ParentNode): void {
  for (const element of root.querySelectorAll<HTMLElement>("[data-icon]")) {
    const path = paths[element.dataset.icon ?? ""];
    if (path) {
      element.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
    }
  }
}
