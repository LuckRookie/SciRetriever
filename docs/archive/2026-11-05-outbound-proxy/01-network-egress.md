# 01 · Network 按发起方选择出口

类型：计划（结果块）
负责：ADR 0056 第 1–4 节的后端
状态：Completed（2026-11-05）

## Outcome

- 普通配置可以写一个 HTTP CONNECT 代理地址，以及经代理的项目清单；代理认证存 `credentials.toml`，与代理地址绑定。
- 每个出网请求按发起方走直连或经代理：文献来源（含它给出的 PDF 链接下载与来源测试）、DOI 解析、模型 Provider、远程 MinerU、浏览器。
- 经代理失败报 `proxy-unavailable`；来源测试、获取轨迹与模型测试的结果注明出口。
- 有“测试代理”的 CLI 与 HTTP 入口；Web 能读写上述配置。

## 进入条件

ADR 0056 Accepted（`989fc8b`）。

## 责任边界

Codex（`sciretriever-web`）：`packages/contracts`、`apps/server` 及测试，技术文档 02 第 7 节与 08 中受影响的段落。不改 `apps/web/`、`docs/guides/`、`docs/notes/`、需求、原则与页面规格。

## Tasks

- [x] **1.1 合同**：配置字段、凭据字段、出口值、`proxy-unavailable`、测试代理的请求与结果、出口标注字段；写进回执 `contract.md`。
- [x] **1.2 连接**：`connectVerified` 与浏览器 loopback 代理的上游支持经代理 CONNECT；隧道内 TLS 与证书校验照旧。
- [x] **1.3 路由**：各发起方把出口带进 Network；本机与局域网目标始终直连。
- [x] **1.4 配置、凭据与测试入口**：校验（经代理而未配代理地址时拒绝保存）、CLI `config`、HTTP、测试代理。
- [x] **1.5 文档**：技术文档 02 第 7 节、08 中“原始出口”“不改变服务器原始出口”等表述改为现行规则。

## 验证

- 直接测试：经代理 CONNECT（含认证）、代理拒绝与不可达、不回退直连、私有地址仍被拒、证书校验仍生效、本机目标不走代理、浏览器上游切换、配置校验、认证与代理地址绑定、出口标注。
- 默认配置（无代理）下现有 Network 与浏览器测试不变。
- 沙箱配置目录（不含凭据）中配置本机代理、只让 Semantic Scholar 经代理：`config test search semantic-scholar` 通过，同时 Crossref 直连通过。

## 退出条件

回执 `DONE.md` 给出提交、合同与验证结果；02 可以按 `contract.md` 接界面。

2026-11-05 已满足：提交 `e4cae62`，回执 `sandbox/reports/2026-11-05-plan18-01/`。真实验证中测试代理与 Crossref 直连通过；Semantic Scholar 经代理已到达目标，但匿名请求两次（Claude 复验一次）都得到 429 限流，见计划进度。
