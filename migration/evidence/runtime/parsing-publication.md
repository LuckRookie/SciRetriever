# 正式 PDF 到 ParserResult 的准备与发布

> 本文件保留迁移期规则 bridge 的历史记录。当前 Parser artifact 校验由 TypeScript
> `TypeScriptParserArtifactRules` 直接提供；生产路径不启动 Python。后文早期测试统计和 bridge 描述不代表当前
> 安装包运行时。

2026-09-10。阶段 05-05 的 Parsing owner 切片。Application 可通过显式 `parsing: {parser, rules}`
组装 `app.parsing`；未配置时为 null，不隐式选择 Parser 或连接 MinerU。

## 当前行为

- `prepareCurrentPrimary(literatureId, signal?)` 读取正式 current primary Asset，使用 Literature 的 verified
  artifact Port 核对实际文件，再经注入的 PDF inspector 检查页数。当前 Bootstrap 复用受限的 pdfinfo，
  输入上限 256 MiB / 10000 页。Parser 收到稳定 AssetId/hash 和作用域内的只读字节能力，不接收机器路径。
- Parser 返回后即关闭输入能力，复制其 Markdown/资源字节和 provenance；外部保留的可变数组不能更改准备结果。
  校验输入 ID/hash、实际页数、共享 ParserResult manifest、parser identity 与 provenance。
- 迁移期 `PythonParserArtifactRules` 曾通过有界 stdio 调用 `sciretriever.parsing.artifact_bridge`，复用既有
  `validate_normalized_parser_artifacts`，验证实际资源语法、规范引用闭合、UTF-8、hash/大小和媒体签名。
  不假设普通 Markdown 链接都属于嵌入资源。Python 不加载配置、不打开 catalog、不访问外部 parser，
  不发布文件；它仅检查传入的合成或正式 parser 输出字节。
- 准备凭据由服务私有持有，公开对象只提供不可变 ParserResult。`commitCurrentPrimary` 单次消费凭据，
  `discardPrepared` 释放未提交准备，Application close 取消准备并使已有凭据失效。调用方不能构造等价对象提交。
- commit 先 create-if-absent 发布全部文件，复用 catalog 已登记的相同 hash/size/media 路径与 artifact 身份，
  再在一个短 SQLite 写事务内确认 Literature 当前 primary ID/hash 并保存 manifest、provenance、资源引用。
  ParserResult 沿用 v1 表，不增加第二套业务事实或 receipt schema。
- 相同 manifest 的重复解析保留首次已接纳 provenance ID/时间，并返回已有结果；manifest 不同则正常替换当前
  ParserResult。后者不删除已发布旧文件，也不撤销已接受 LiteratureContent。
- 过期输入、资源/字节不合法、parser 故障、取消、已有文件异字节及 provenance ID 冲突均返回稳定错误。
  失败不撤销有效 PDF/ParserResult/Content。文件已发布而事务未提交时，文件可能暂未登记；重试可核对复用。
  commit 开始后由提交路径完成或报告失败，取消不虚构回滚已经发布的字节。

```ts
const prepared = await app.parsing!.prepareCurrentPrimary(literatureId, signal);
const result = await app.parsing!.commitCurrentPrimary(prepared, signal);
```

## 直接证据

迁移期 `parsing-artifact-rules.test.ts` 曾由 Vitest 调用实际 Python 规则 owner，覆盖资源闭合、重复/危险引用、错误 hash、
错误媒体签名、非 UTF-8、空白 Markdown、非规范引用、取消、执行期限、缺失解释器及闭合 JSON 协议。
每个拒绝案例独立执行，未提高默认单项测试超时。

`parsing-service.test.ts` 使用真实 Application、SQLite、FileStore、pdfinfo 与合成 ParserPort，覆盖：

- 只准备时没有 ParserResult，完成提交后实际 Detail 和 artifact Port 可读，重启后仍可读。
- Parser 返回数组改写、输入能力逃逸、伪造/重复凭据、discard、Application close。
- 物理页数/来源 hash 不符、字节损坏、parser 抛错、准备/提交前取消，既有结果和 PDF 事实保留。
- 在准备后实际修改临时 catalog 的 primary 关系，验证提交事务拒绝过期结果。
- 实际文件冲突、provenance ID 冲突及现有结果保留。
- 非 BMP 与 BMP 资源按 Python Unicode 顺序发布；两个引用复用同一已注册文件和 artifact ID。
- metadata revision 10000 仍可经过 Detail/current facts 与 Parsing；修正两个 DTO 原先误用年份上限 9999 的问题。

`literature-detail.test.ts` 联合回归验证现有 Parser/Content 差分和完整详情读取。

## 范围与后续

这段记录形成时尚不是完整 05-05；operator-managed MinerU 的实际执行适配、Analysis 两阶段运行、Literature 内容
接纳 owner、Web 操作入口和 Candidate → Parse → Analyze 旅程随后已接入。当前 TypeScript 生产路径直接使用
Parser 执行 Port 和规则 owner；没有连接真实 MinerU/LLM/Provider，也没有新增依赖。

## 本次验收

`SCIRETRIEVER_CLOAK_BUNDLE=/home/duanjw/.sciretriever/cloakbrowser-cache/chromium-146.0.7680.177.5 pnpm full`
已通过：65 个测试文件、228 项测试，含实际目标 Cloak 的本地工作台旅程；Quick、strict 类型检查、离线包
安装测试和 workspace build 均通过。日志：`/tmp/sciretriever-parsing-full.log`。
新增 Python bridge 文件单独 Ruff lint/format 通过；未运行 Python Quick/Full/unittest。
`git diff --check` 通过。未执行 Git 提交、推送、PR 或生产数据操作。

后续更新：实际 operator-managed MinerU 的 loopback 执行与配置组装已在[MinerU 执行切片](mineru-execution.md)完成验证；本页保留当时切片范围，Analysis 和完整用户旅程仍待继续。
