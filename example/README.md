# SciRetriever 使用示例

本目录只展示当前安装后 `sciretriever` CLI 的用法。所有示例都经过当前统一数据库、Provider
readiness、共享限速、PDF validation 和不可变发布边界；不直接调用内部 vendor client。

## 1. 准备固定用户配置

推荐先运行统一配置中心；第一次确认修改时，它会创建固定的普通配置文件：

```bash
sciretriever config
```

纯本地起步需要设置 Catalog 与 ArtifactStore 路径，也可以在确认目标尚不存在后，从仓库根目录
复制公开的非敏感配置模板：

```bash
mkdir -p ~/.sciretriever
chmod 700 ~/.sciretriever
cp -n example/config.example.toml ~/.sciretriever/config.toml
chmod 600 ~/.sciretriever/config.toml
```

已有 `~/.sciretriever/config.toml` 时必须人工比较并合并，不能用示例覆盖。编辑固定文件中的
`[paths]`，填写真实绝对 Catalog 和 ArtifactStore 路径。不要在普通配置中写 API key、token
或 Cookie。文献 Provider、Model Provider 与远程 MinerU secret 只通过以下交互中心管理：

```bash
sciretriever config
sciretriever config status
```

所有正常命令从任意工作目录都只读取 `~/.sciretriever/config.toml`；当前目录文件和旧配置路径
环境变量不会生效。旧文件不会自动迁移或删除。

### 1.1 配置 Model、Analyze、Download 与 MinerU

再次运行 `sciretriever config`，按首页本地 readiness 逐项完成：

1. 打开 `Models → Add`，选择已有 Provider 或 `New`。新增远程 Provider 时确认 URL/API，并在同一
   流程隐藏输入 Key；Key 就绪后程序自动读取一次模型目录。只有目录失败、为空或无法安全解析时
   才出现 `Manual`。随后选择 Reasoning、Image 与 Stream 并保存完整 `provider/model` Model。
   Stream 默认开启，也可按具体 Model 关闭。Provider 与
   Key 的独立管理入口是 `Models → Providers`。
2. 打开 `Analyze → Setup` 直接选择一个 Model 并确认文献分析预算。Analyze 只保存完整 Model
   reference；reasoning/stream 属于 Model，strict structured output/text-only/no-tool 由模块派生。
3. 打开 `Parse → Setup`。本机 operator-managed MinerU 选择 loopback；远程服务在同一流程明确授权
   PDF 上传，并配置与该 origin 绑定的 bearer token。
4. 若使用 Agent 下载 PDF，在 `Browser → Setup` 选择 `agent` 和一个 `image = true` 的 Model，并
   初始化固定 Browser identity；再通过 `Runtime` 检查 CloakBrowser。PNG/tool/图片限制由 Browser
   调用合同派生；只需确定性规则时选择 `rules`，不会调用 Browser Model。
5. 若确实获准使用 Sci-Hub Source，先把 `Download → Sources` 切到 `Custom`，再进入 `sci-hub`
   直接 `Enable` 当前版本
   builtin；需要自定义时用 `Mirrors → Add / Remove / Save` 保存一到八个 HTTPS URL，`Reset` 恢复
   跟随 builtin。顺序就是尝试顺序；程序不自动发现或并发请求镜像，也不询问 Key/Cookie/代理。
   operator 必须自行确认适用法律、机构政策、内容许可与服务条款。

配置只证明本地字段完整。按需执行显式验证：

```bash
sciretriever config test llm
sciretriever config test browser-agent
sciretriever config test mineru
sciretriever config status
```

Browser model probe 只发送合成图片和封闭工具，不启动浏览器；实际 runtime/Publisher 最小目标
需要另行执行 `sciretriever config test --browser ACCESS_KEY`。这些探测不会把结果写入文献数据库。

## 2. 完全离线的本地旅程

准备自己的 BibTeX/BibLaTeX、RIS 或 CSL JSON 文件，然后从任意目录执行：

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

Metadata/Acquisition 默认使用当前版本维护的 Auto 集合；可以在 `Search/Download → Sources`
切到 Custom，冻结精确 Provider 列表与顺序，或用 Custom 空列表关闭命名 Provider。Search 的
`Limit` 分别应用到每个有效 Metadata Source。通过 `sciretriever config status` 检查本地
readiness；只有在确实需要验证外部服务时，才运行可能联网或消耗额度的显式 `config test`。

```bash
sciretriever discover topic "AI for science" --year-from 2020 --json
sciretriever complete pdf --all-pending --json
```

发现只接纳元数据，不顺带下载 PDF。PDF Completion 固定按 Public → Authorized Provider API
→ Controlled Browser-last 逐层升级；当前内置 9 条 production Browser route，但只有配置启用、
Profile/runtime/controller 就绪且当前文章适用时才会访问对应出版社页面。详细支持矩阵、限速、
预计时间和失败处理见
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
