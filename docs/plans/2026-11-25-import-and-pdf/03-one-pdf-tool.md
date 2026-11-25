# 03 PDF 工具合一

类型：计划（结果块）
负责：下载验收改用 MuPDF，去掉对 pdfinfo 与 pdftotext 的依赖
状态：Pending

## Outcome

程序只依赖 MuPDF 一套 PDF 工具。安装时少一样要带的部件，`doctor` 与启动把关的清单随之缩短。

## 进入条件

- 现状：MuPDF 用于读导入的 PDF、识别书目、校订时渲染页面；`pdfinfo`、`pdftotext` 只用在 `apps/server/src/acquisition/pdf-acceptance.ts`（下载回来的 PDF 的验收）与 `doctor` 的检查项。
- [ADR 0066](../../architecture/decisions/0066-complete-program-or-failed-build.md)“还没有验证的前提”第二条：两者的结果是否一致没有比较过。

## 责任边界

只换验收里取信息的工具；验收的判断规则（是不是合法 PDF、页数、加密、是不是这篇文章）不变。

## Tasks

- [ ] 3.1 比对（后端，只读）：对正式库已有的全部 PDF，分别用两套工具取：能否打开、页数、是否加密、取出的文字。逐项记录不一致的篇数与样例；另加几份构造的坏文件（截断、加密、不是 PDF）。结果写成表放在本块。
- [ ] 3.2 决定（总设计师）：不一致之处逐类判断哪一个对、换了之后验收结论会不会变；会变的列出来，有影响使用者已有文献的问 Owner。
- [ ] 3.3 后端：`pdf-acceptance.ts` 改用 MuPDF；超时、输出上限、隔离照现有做法。`doctor`、启动把关、运行清单（`release/manifests/runtime-support.json`）去掉 `pdfinfo`、`pdftotext`。
- [ ] 3.4 文档：[安装指南](../../guides/installation.md)与 README 的前提条件同步。

## 集成与影响

获取 PDF 的验收路径；安装与环境检查。不改库结构，不重新验收已有的 PDF。

## 验证

- 3.1 的表。
- 现有的验收测试全部通过；坏文件各一条。
- 在一台没有 `pdfinfo`、`pdftotext` 的环境里（或把它们从 `PATH` 里拿掉）构建、启动、`doctor` 通过。

## 退出条件

仓库里不再调用 `pdfinfo`、`pdftotext`；3.1 的结论写在本块；文档同步；已部署。

## 恢复与交接

3.2 认为差异不可接受时，本块停在 3.2，保留两套工具，改为把 `pdfinfo`、`pdftotext` 随程序带上的办法另议。

[上级目录](README.md)
