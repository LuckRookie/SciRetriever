// Builds what a device connection downloads (plan 20, block 06): the skill as a
// ZIP of skills/sciretriever/, and the same text as one Markdown document for
// Agents that read instructions rather than install skills.
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { zip } from "./build-browser-extension.mjs";

const repository = resolve(new URL("..", import.meta.url).pathname);
const skill = resolve(repository, "skills/sciretriever");
const output = resolve(repository, "apps/server/dist/agent-access");
/** The order a reader meets the skill in; anything else follows by name. */
const ORDER = [
  "SKILL.md",
  "connect.md",
  "import.md",
  "source-zotero.md",
  "use.md",
  "recovery.md",
];

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const found = await Promise.all(
    entries
      .filter(
        (entry) =>
          !["tests", "__pycache__"].includes(entry.name) &&
          !/\.py[co]$/u.test(entry.name),
      )
      .map((entry) => {
        if (entry.isSymbolicLink())
          throw new Error("Skill packages must not contain symbolic links");
        return entry.isDirectory()
          ? files(join(directory, entry.name))
          : [join(directory, entry.name)];
      }),
  );
  return found.flat();
}

export async function buildAgentAccess(source = skill, target = output) {
  const paths = (await files(source))
    .map((path) => relative(source, path).split("\\").join("/"))
    .sort(
      (a, b) =>
        (ORDER.indexOf(a) + 1 || ORDER.length + 1) -
          (ORDER.indexOf(b) + 1 || ORDER.length + 1) || a.localeCompare(b),
    );
  const entries = await Promise.all(
    paths.map(async (path) => ({
      name: `sciretriever/${path}`,
      path,
      bytes: await readFile(join(source, path)),
    })),
  );
  // One document: the skill without its front matter, then each page in order.
  const pages = entries
    .filter((entry) => entry.path.endsWith(".md"))
    .map((entry) =>
      entry.bytes
        .toString("utf8")
        .replace(/^---\n[\s\S]*?\n---\n+/u, "")
        .trim(),
    );
  const instructions = [
    ...pages,
    "完整的 skill（含 `scripts/` 下的上传与导入程序）可以从 `GET <地址>/api/v1/intake/skill` 下载，请求头同上。",
  ].join("\n\n---\n\n");
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "agent-guide.md"), `${instructions}\n`);
  await writeFile(join(target, "skill.zip"), zip(entries));
  return target;
}

if (import.meta.url === `file://${process.argv[1]}`) await buildAgentAccess();
