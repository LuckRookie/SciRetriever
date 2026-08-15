# SciRetriever 使用示例

本目录只展示当前安装后 `sciretriever` CLI 的用法。所有示例都经过当前统一数据库、Provider
readiness、共享限速、PDF validation 和不可变发布边界；不直接调用内部 vendor client。

## 1. 准备一个私有运行目录

从仓库根目录复制公开的非敏感配置示例：

```bash
mkdir -p /absolute/private/path/sciretriever-run
cp example/config.example.toml /absolute/private/path/sciretriever-run/config.toml
```

编辑副本中的 `[paths]`，填写真实绝对 Catalog 和 ArtifactStore 路径。不要在普通配置中写 API
key、token 或 Cookie。Provider、LLM 与远程 MinerU secret 只通过以下交互中心管理：

```bash
cd /absolute/private/path/sciretriever-run
sciretriever config
sciretriever config status
```

## 2. 完全离线的本地旅程

准备自己的 BibTeX/BibLaTeX、RIS 或 CSL JSON 文件，然后在运行目录执行：

```bash
sciretriever import metadata bibtex /absolute/private/path/library.bib --json
sciretriever literature search --json
sciretriever literature show LITERATURE_ID --json
sciretriever import pdf LITERATURE_ID /absolute/private/path/article.pdf --json
sciretriever export pdf LITERATURE_ID /absolute/private/path/article-copy.pdf --json
```

这些命令只访问本地文件、Catalog 和 ArtifactStore，不调用外部 Provider。手动 PDF 会复制而不
移动原文件，并经过与自动获取相同的 PDF 字节和不可变发布检查。

## 3. 发现与自动 PDF 补全

先在私有 `config.toml` 中明确启用所需 Metadata/Acquisition Provider，并通过
`sciretriever config status` 检查本地 readiness。只有在确实需要验证外部服务时，才运行可能
联网或消耗额度的显式 `config test`。

```bash
sciretriever discover topic "AI for science" --year-from 2020 --json
sciretriever complete pdf --all-pending --json
```

发现只接纳元数据，不顺带下载 PDF。PDF Completion 固定按 Public → Authorized Provider API
→ Controlled Browser-last 逐层升级；当前 production Browser route count 为 `0`，不会访问出版社
Browser 页面。详细支持矩阵、限速、预计时间和失败处理见
[`docs/guides/pdf-acquisition.md`](../docs/guides/pdf-acquisition.md)。

需要逐步骤诊断时使用全局 `--debug`，并把结果与日志分别保存：

```bash
mkdir -p reports logs
sciretriever --debug complete pdf --all-pending --json \
  > reports/completion.json \
  2> logs/completion.log
```

示例中的绝对路径、`LITERATURE_ID` 和研究主题都必须由用户替换；本目录不包含个人配置、凭据、
数据库、PDF、真实 Provider 响应或用户语料。
