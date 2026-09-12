# Literature artifact 读取与导出

2026-09-10。开发期 Application 新增 `literatureArtifacts.withArtifact()`；Entry 新增公开导出的
`exportArtifact()`。它们直接消费 LiteratureDetail 已返回的 `Asset | ParserArtifactRef | ArtifactRef`，
不新增文件 token、数据库表、身份或持久化路径事实。

## 读取

`withArtifact(descriptor, consume, {maxBytes?, signal?})` 只在 callback 作用域内提供只读
`AsyncIterable<Uint8Array>`。Catalog 根据 hash/size/media type 解析正式对象；Asset 还必须与已登记的
AssetId 和规范相对路径完全一致。未登记对象、错误路径或 media type 拒绝进入文件读取。

Storage 的 `openVerifiedFile`：

- 从文件系统根开始逐段 no-follow 打开目录，Linux 用目录 FD 锚定下一段，拒绝目录和文件符号链接。
  最终文件使用 nonblocking 打开后检查普通文件，避免特殊文件阻塞；要求只有一个硬链接。
- 交出流前核对大小并按 1 MiB chunk 扫描完整 SHA-256，同时比较 dev/inode/nlink/size/mtime/ctime；
  重新打开命名对象确认名称仍指向已验证 inode。media type 来自已匹配的 catalog descriptor，不从后缀推断。
- 按需返回至多 1 MiB 的独立字节块，逐块检查取消和 inode 元数据；调用方修改返回数组不修改正式文件。
  成功离开作用域前再次扫描 hash 并验证命名对象。提前 break 也执行最终核验；consumer 自身错误保留并关闭资源。
- 流只能消费一次，不能在 callback 返回后继续使用；FileStore 关闭会取消正在打开的 reader，并主动释放
  已打开作用域的句柄，即使 consumer 仍在等待。consumer 恢复后不能继续读取或成功确认结果。
- 默认上限沿用 FileStore 的 512 MiB 运行预算，可通过 `maxBytes` 显式设置；全程不物化完整大文件。

调用形式：

```ts
const detail = await app.library.detail(literatureId);
if (detail.primary_pdf) {
  await app.literatureArtifacts.withArtifact(
    detail.primary_pdf.asset,
    async (chunks) => {
      for await (const chunk of chunks) await destination.write(chunk);
    },
    { signal },
  );
}
```

## 导出

`exportArtifact(app.literatureArtifacts, descriptor, absoluteTarget, {overwrite?, maxBytes?, signal?})`
属于 Entry 的外部 I/O，目标由调用方显式提供，不写入 catalog、Model、provenance 或 Report。

- 逐段打开并锚定目标目录，在同一目录创建随机、exclusive、0600 临时文件。
- 使用同一 verified reader，完整处理 partial write，校验输入字节数/hash，fsync 后再读回临时文件复核。
- 提交前确认临时名称仍指向同一普通 inode，目标目录未被替换；检查取消。
- 默认通过 create-if-absent 硬链接原子发布，已有目标即使字节相同也拒绝；`overwrite: true` 才使用原子 rename
  替换。读/写/校验/取消失败不暴露半文件，默认冲突和失败替换均保留旧目标。
- 清理只删除仍属于本次创建 inode 的临时文件，关闭全部句柄。原子发布后的目录同步故障会以稳定
  `ArtifactExportError.published = true` 表示目标已经发布，不虚构已回滚；普通提交前失败为 false。

## 验证

`literature-artifact.test.ts` 在系统临时目录，用真实 Application、SQLite、FileStore 和 3 MiB + 7 bytes
合成文件验证：Asset/path-free descriptor 两种入口、分块/限额、consumer 抛错、提前 break、取消、逃逸流拒绝、
应用关闭时释放作用域、返回数组独立性、错误 hash/media type、硬链接/符号链接、读取期间改写和目录替换。

导出验证实际字节/hash、0600 权限、默认冲突保留、显式替换、两次并发导出只有一次成功、读取中取消、
目标目录链接拒绝、损坏源不覆盖既有目标，以及输出目录没有遗留临时文件。
`literature-detail.test.ts` 进一步用真实详情取得 PDF、Parser Markdown、资源与规范内容 Markdown，逐项通过
公开接口读取并核对 hash。

初次测试超时来自对大型 Buffer 的深比较；独立编译后 3 MiB 读取及前后验证约 27 ms。直接测试改用长度与
SHA-256 核对，不放宽测试超时。该数值仅为本机观察，不是吞吐 SLA。

TS Full 已通过：63 文件、211 测试，包含目标 Cloak 的 loopback 工作台旅程。日志
`/tmp/sciretriever-artifact-full.log`。未运行 Python Quick/Full/unittest；`git diff --check` 通过。

本切片未访问真实外部服务或用户目录，未新增依赖、CLI 命令或 v1 schema。后续
[Web 文献库](workbench-library.md)已接入正式 PDF/Markdown 下载与 BibTeX/RIS 导出，
[Browser→MinerU→Analysis 联合旅程](browser-mineru-analysis-journey.md)已让正式 Parser/Analysis 消费这些对象。
