import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const posix = (value) => value.split(sep).join("/");
const sourceReadme = (path) =>
  path.includes("/src/") && path.endsWith("/README.md");

async function walk(root, directory) {
  const result = [];
  let entries;
  try {
    entries = await readdir(resolve(root, directory), { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return result;
    throw error;
  }
  for (const entry of entries) {
    if (
      ["node_modules", "dist", "build", ".git", ".cache"].includes(entry.name)
    )
      continue;
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (path !== "docs/archive") result.push(...(await walk(root, path)));
    } else if (entry.isFile() && path.endsWith(".md")) result.push(path);
  }
  return result;
}

/** Mask code while preserving offsets and line numbers. */
function prose(text) {
  let fence = null;
  return text
    .split("\n")
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (fence) {
        if (
          marker &&
          marker[1][0] === fence[0] &&
          marker[1].length >= fence.length &&
          /^\s*$/.test(line.slice(marker[0].length))
        )
          fence = null;
        return " ".repeat(line.length);
      }
      if (marker) {
        fence = marker[1];
        return " ".repeat(line.length);
      }
      return line;
    })
    .join("\n");
}
function withoutInlineCode(text) {
  return text.replace(/(`+)([\s\S]*?)\1/g, (match) =>
    match.replace(/[^\n]/g, " "),
  );
}
export function headingSlug(value) {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/(`+)(.*?)\1/g, "$2")
    .replace(/(\*\*|__|~~)(.*?)\1/g, "$2")
    .replace(/(?<!\w)[*_]([^*_]+)[*_](?!\w)/g, "$1")
    .replace(/[\\`*~]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
    .replace(/\s/g, "-");
}
function anchors(text) {
  const clean = prose(text),
    ids = new Set(),
    counts = new Map();
  const add = (title) => {
    const base = headingSlug(title),
      count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    ids.add(count ? `${base}-${count}` : base);
  };
  const lines = clean.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = /^ {0,3}#{1,6}\s+(.+?)(?:\s+#+\s*)?$/.exec(lines[i]);
    if (match) add(match[1]);
    else if (
      i > 0 &&
      /^ {0,3}(?:=+|-+)\s*$/.test(lines[i]) &&
      lines[i - 1].trim() &&
      !lines[i - 1].includes("|")
    )
      add(lines[i - 1]);
  }
  for (const match of clean.matchAll(
    /<[a-z][a-z\d-]*\b[^>]*\bid=["']([^"']+)["'][^>]*>/gi,
  ))
    ids.add(match[1]);
  for (const match of clean.matchAll(
    /<a\b[^>]*\bname=["']([^"']+)["'][^>]*>/gi,
  ))
    ids.add(match[1]);
  return ids;
}
function closing(text, start, open, close) {
  let depth = 1;
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] === open) depth++;
    if (text[i] === close && --depth === 0) return i;
    if (text[i] !== close && text[i] !== open) continue;
  }
  return -1;
}
function links(text) {
  const clean = withoutInlineCode(prose(text)),
    found = [],
    definitions = new Map();
  const target = (raw) =>
    raw.trim().startsWith("<")
      ? raw.trim().slice(1, raw.trim().indexOf(">"))
      : raw.trim().split(/\s+["']/)[0];
  for (const match of clean.matchAll(
    /^ {0,3}\[([^\]\n]+)\]:\s*(<[^>]+>|\S+)(?:\s+.*)?$/gm,
  )) {
    definitions.set(match[1].toLowerCase(), target(match[2]));
    found.push({ target: target(match[2]), offset: match.index });
  }
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] !== "[" || clean[i - 1] === "\\") continue;
    const end = closing(clean, i, "[", "]");
    if (end < 0) continue;
    const label = clean.slice(i + 1, end);
    if (clean[end + 1] === "(") {
      const last = closing(clean, end + 1, "(", ")");
      if (last >= 0) {
        found.push({ target: target(clean.slice(end + 2, last)), offset: i });
      }
    } else if (clean[end + 1] === "[") {
      const last = clean.indexOf("]", end + 2);
      if (last >= 0) {
        const reference = (clean.slice(end + 2, last) || label).toLowerCase();
        if (!definitions.has(reference))
          found.push({ target: null, offset: i, reference });
        i = last;
      }
    }
  }
  for (const match of clean.matchAll(
    /<(?:a|img)\b[^>]*\b(?:href|src)=["']([^"']+)["'][^>]*>/gi,
  ))
    found.push({ target: match[1], offset: match.index });
  return found;
}

export async function checkDocuments(root) {
  root = resolve(root);
  const candidates = [
    "README.md",
    "AGENTS.md",
    "HARNESS.md",
    "scripts/README.md",
    "docs/archive/README.md",
    ...(await walk(root, "docs")),
    ...[
      ...(await walk(root, "apps")),
      ...(await walk(root, "packages")),
    ].filter((p) => p.endsWith("/README.md")),
  ];
  const files = [...new Set(candidates)].sort(),
    issues = [],
    cache = new Map();
  let checked = 0,
    sourceExceptions = 0;
  const read = async (path) => {
    if (!cache.has(path)) cache.set(path, await readFile(path, "utf8"));
    return cache.get(path);
  };
  for (const path of files) {
    const absolute = resolve(root, path);
    let text;
    try {
      text = await read(absolute);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    checked++;
    const issue = (code, line, detail) =>
      issues.push({
        severity: "error",
        file: path,
        line,
        code,
        detail,
      });
    if (sourceReadme(path)) sourceExceptions++;
    else {
      const opening = prose(text).split("\n").slice(0, 12).join("\n");
      const header =
        /类型[：:]\s*[^\n]+\n负责[：:]\s*([^\n]+)\n状态[：:]\s*([^\n]+)/.exec(
          opening,
        );
      if (!header)
        issue(
          "document-header",
          1,
          "Expected type, responsibility and status on three consecutive lines near the title.",
        );
      else {
        if (/现行（范围与未决项见正文）|现行目录说明/.test(header[2]))
          issue(
            "document-status",
            1,
            "State current status without generic boilerplate.",
          );
        const title = /^#\s+(.+?)(?:\s+#+\s*)?$/m.exec(opening)?.[1];
        const plain = (value) =>
          value
            .replace(/[*_`]/g, "")
            .trim()
            .replace(/[。.]$/, "");
        if (
          title &&
          path !== "README.md" &&
          !path.endsWith("/README.md") &&
          !path.startsWith("docs/notes/providers/") &&
          plain(title) === plain(header[1])
        )
          issue(
            "document-responsibility",
            1,
            "Describe the owned topic instead of repeating the title.",
          );
      }
    }
    for (const link of links(text)) {
      const line = text.slice(0, link.offset).split("\n").length;
      if (link.target === null) {
        issue("reference-missing", line, link.reference);
        continue;
      }
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(link.target)) {
        if (sourceReadme(path))
          issue("source-readme-boundary", line, link.target);
        continue;
      }
      let url;
      try {
        url = decodeURIComponent(link.target.replace(/\\([()[\] ])/g, "$1"));
      } catch {
        issue("link-encoding", line, link.target);
        continue;
      }
      const hash = url.indexOf("#"),
        fragment = hash >= 0 ? url.slice(hash + 1) : "",
        local = (hash >= 0 ? url.slice(0, hash) : url).split("?")[0];
      let destination = local
        ? resolve(
            local.startsWith("/") ? root : dirname(absolute),
            local.replace(/^\//, ""),
          )
        : absolute;
      const repositoryPath = relative(root, destination);
      if (
        repositoryPath.startsWith(`..${sep}`) ||
        repositoryPath === ".." ||
        isAbsolute(repositoryPath)
      ) {
        issue("link-outside-repository", line, link.target);
        continue;
      }
      if (sourceReadme(path)) {
        const base = resolve(root, path.slice(0, path.indexOf("/src/") + 4));
        const distance = relative(base, destination);
        if (distance.startsWith("..") || isAbsolute(distance))
          issue("source-readme-boundary", line, link.target);
      }
      try {
        const stats = await stat(destination);
        if (stats.isDirectory()) {
          if (fragment) destination = resolve(destination, "README.md");
          else continue;
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        issue("link-missing", line, link.target);
        continue;
      }
      if (fragment && destination.endsWith(".md")) {
        try {
          if (!anchors(await read(destination)).has(fragment))
            issue("anchor-missing", line, link.target);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          issue("link-missing", line, link.target);
        }
      }
      const targetPath = posix(relative(root, destination));
      const start = Math.max(
        text.lastIndexOf("\n\n", link.offset) + 2,
        ...["。", "；"].map((p) => text.lastIndexOf(p, link.offset) + 1),
      );
      const endings = ["。", "；", "\n\n"]
        .map((p) => text.indexOf(p, link.offset))
        .filter((n) => n >= 0);
      const sentence = text.slice(
        start,
        endings.length ? Math.min(...endings) : text.length,
      );
      if (
        !path.startsWith("docs/archive/") &&
        targetPath.startsWith("docs/archive/") &&
        !/(?:历史|归档|Supersedes|Superseded|Date:)/i.test(sentence) &&
        /(?:现行依据|当前规范|当前合同|权威依据|必须遵守|以[^\n]{0,80}为准)/.test(
          sentence,
        )
      )
        issue("archive-as-current", line, link.target);
    }
  }
  return {
    checked,
    sourceExceptions,
    errors: issues,
  };
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const result = await checkDocuments(
    resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  );
  if (process.argv.includes("--json"))
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    for (const item of result.errors)
      process.stdout.write(
        `${item.severity}: ${item.file}:${item.line} ${item.code}: ${item.detail}\n`,
      );
    process.stdout.write(
      `Checked ${result.checked} documents; ${result.errors.length} errors; ${result.sourceExceptions} source README header exemptions.\n`,
    );
  }
  if (result.errors.length) process.exitCode = 1;
}
