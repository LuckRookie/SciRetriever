// First step of `pnpm build` (ADR 0066): the built program includes MuPDF.
// A verified bundle is kept as it is, so offline workspaces build as before;
// otherwise the pinned source is fetched and compiled, and failure fails the build.
import { createHash } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { access, lstat, readFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MUPDF, buildMupdf, mupdfOutput } from "./build-mupdf.mjs";

/**
 * The same acceptance as resolveMupdfRuntime() in
 * apps/server/src/proofread/mupdf.ts: manifest, version, platform, an
 * executable bin/mutool and its SHA-256.
 */
export async function mupdfBundleReady(
  bundle,
  platform = `${process.platform}-${process.arch}`,
) {
  try {
    const manifest = JSON.parse(
      await readFile(join(bundle, "manifest.json"), "utf8"),
    );
    if (
      manifest.name !== "mupdf" ||
      manifest.version !== MUPDF.version ||
      manifest.platform !== platform ||
      manifest.executable !== "bin/mutool" ||
      typeof manifest.executable_sha256 !== "string"
    )
      return false;
    const executable = join(bundle, "bin", "mutool");
    const stat = await lstat(executable);
    if (!stat.isFile() || !(stat.mode & 0o100)) return false;
    return (
      createHash("sha256")
        .update(await readFile(executable))
        .digest("hex") === manifest.executable_sha256
    );
  } catch {
    return false;
  }
}

async function onPath(name) {
  for (const directory of (process.env.PATH ?? "")
    .split(delimiter)
    .filter((value) => value.startsWith("/")))
    try {
      await access(join(directory, name), constants.X_OK);
      return true;
    } catch {
      // Keep looking through PATH.
    }
  return false;
}
/** Commands the source build runs; a C compiler under either common name. */
async function missingTools(find) {
  const missing = [];
  if (!(await find("cc")) && !(await find("gcc"))) missing.push("gcc");
  for (const name of ["make", "tar", "objdump"])
    if (!(await find(name))) missing.push(name);
  return missing;
}

export class MupdfBuildError extends Error {
  constructor(reason, remedy, options) {
    super(
      [
        `构建失败：缺少 MuPDF ${MUPDF.version}。读 PDF 的标题、作者和 DOI，以及生成全文，都要用它；构建会自动编译它，这一步没有成功。`,
        `原因：${reason}`,
        `办法：${remedy}`,
      ].join("\n"),
      options,
    );
    this.name = "MupdfBuildError";
  }
}

const offline = `不能联网时，在能联网的机器上下载 ${MUPDF.source_url}，复制过来后执行 \`node scripts/vendor/build-mupdf.mjs --source <下载的文件>\`，再执行 \`pnpm build\`。`;

/**
 * Keeps a verified bundle; otherwise builds one with `build` (the pinned
 * source build by default). Throws MupdfBuildError saying what is missing,
 * why, and what to do.
 */
export async function ensureMupdf({
  output = mupdfOutput(),
  build = buildMupdf,
  findTool = onPath,
  log = (text) => process.stderr.write(text),
} = {}) {
  if (await mupdfBundleReady(output)) {
    log(`MuPDF ${MUPDF.version} 已就绪（${output}），不再编译。\n`);
    return { built: false, output };
  }
  if (existsSync(output))
    throw new MupdfBuildError(
      `${output} 已存在，但不是能用的 MuPDF ${MUPDF.version}（清单、版本或可执行文件摘要对不上）。`,
      `确认这个目录没有别的用处后删除它，再执行 \`pnpm build\`。`,
    );
  const tools = await missingTools(findTool);
  if (tools.length)
    throw new MupdfBuildError(
      `编译 MuPDF 需要的命令找不到：${tools.join("、")}。`,
      `安装它们（例如系统的 gcc、make、tar 与 binutils）后重新执行 \`pnpm build\`。`,
    );
  log(
    `没有找到 MuPDF ${MUPDF.version}，开始下载固定版本的源码并编译，需要联网，约需几分钟……\n`,
  );
  try {
    await build({ output });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const download =
      /download failed|fetch failed/iu.test(message) ||
      (error instanceof TypeError && /fetch/iu.test(message));
    throw new MupdfBuildError(
      download
        ? `下载 MuPDF 源码失败，可能不能联网（${message}）。`
        : /pinned SHA-256/u.test(message)
          ? "下载到的 MuPDF 源码与固定的 SHA-256 不符。"
          : /linux-x64 only/u.test(message)
            ? `这台机器是 ${process.platform}-${process.arch}，MuPDF 的随包构建只支持 linux-x64。`
            : `编译 MuPDF 没有成功（${message}）。`,
      download
        ? offline
        : /linux-x64 only/u.test(message)
          ? "在 linux-x64 上构建。"
          : `看上面的编译输出，补上缺的东西后重新执行 \`pnpm build\`。${offline}`,
      { cause: error },
    );
  }
  if (!(await mupdfBundleReady(output)))
    throw new MupdfBuildError(
      `编译结束，但 ${output} 没有通过核对。`,
      `删除这个目录后重新执行 \`pnpm build\`。`,
    );
  log(`MuPDF ${MUPDF.version} 已编译到 ${output}。\n`);
  return { built: true, output };
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  try {
    await ensureMupdf();
  } catch (error) {
    process.stderr.write(
      `${error instanceof MupdfBuildError ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
