# ScanSci PDF 迁移许可与证据审计

- 审计日期：2026-08-15
- 审计对象：<https://github.com/Rimagination/scansci-pdf>
- 固定 revision：`5e4a6f20ee32b16c0fcb52e37b66ca7a0b31edc5`（Release v1.9.0）
- SciRetriever 审计基线：`6708499`
- 文档性质：第三方参考实现的许可、provenance 与迁移边界 Notes

本文只记录 ScanSci PDF 当前固定快照对 SciRetriever PDF 获取改革的参考边界，不批准任何 Provider 上线，也不把上游运行记录、selector、URL template 或验证结论变成本项目事实。获取顺序和安全合同仍以 [ADR 0015](../architecture/decisions/0015-publisher-aware-tiered-pdf-acquisition.md)、[Acquisition 技术文档](../architecture/technical/acquisition.md)与 [Network 技术文档](../architecture/technical/network.md)为准。

本次审计只读取仓库外的本地 Git checkout、许可证、源码和静态数据；没有连接真实 Provider、机构登录或 Browser profile，没有读取 Cookie、凭据或个人会话，也没有执行现场下载。

## 1. 许可结论

ScanSci PDF 根 `LICENSE` 是 Apache License 2.0，并声明：

```text
Copyright 2024-2026 scansci-pdf contributors
```

当前 checkout 没有单独的 `NOTICE` 或 `COPYING` 文件。许可证末尾另有不能忽略的例外：`src/scansci_pdf/_core/` 中通过 PyPI 分发的 `*.pyd`、`*.so` 是预编译扩展，其未提供的 Cython `*.pyx` 源码为 proprietary；主源码中的纯 Python fallback 才明确适用 Apache-2.0。

因此迁移边界是：

- 可以阅读 Apache-2.0 源码并借鉴不受表达保护的抽象理念；
- 实质复制或改写源码、常量表、selector、URL template 或数据 catalog 前，必须保留适用的 Apache-2.0 许可证和版权声明、标出修改，并登记逐文件 provenance；
- `_core` 的二进制、未提供源码及其反向工程结果永不迁移；
- 上游没有独立 NOTICE 不等于无需履行 Apache-2.0 的许可证、版权和修改声明义务。

根级 [NOTICE](../../NOTICE) 保存面向发行物的简要归属和后续登记要求，但不定义 SciRetriever 自身许可证。

## 2. 当前复制状态

截至上述 SciRetriever 审计基线，本专项迁移登记表为空：当前实现没有把 ScanSci PDF 的源码、数据 catalog、selector、URL template 或二进制捆绑进 SciRetriever。现有 Browser foundation 与三层编排按 SciRetriever 的 Accepted ADR、模块合同和本地离线 fixture 清洁实现。

| SciRetriever 文件 | 上游文件/对象 | 方式 | 修改声明 | 独立证据与 fixture |
| --- | --- | --- | --- | --- |
| 无 | 无 | 仅参考理念；未复制 | 不适用 | P39-P53 的 SciRetriever 自有合同与离线 fixture |

若后续表中出现条目，单写“参考 ScanSci”不够；必须同时记录上游 commit、精确文件和对象或行、`copy`/`adapt`/`clean rewrite`、SciRetriever 目标文件、修改说明、官方独立证据、fixture revision 与复核日期。

## 3. 三类迁移边界

### 3.1 只作理念参考并清洁重实现

| 抽象理念 | 可接受的 SciRetriever 表达 | 不能继承的上游事实 |
| --- | --- | --- |
| Publisher/access platform 识别 | 使用强弱证据形成无副作用 `PublisherAccessResolution` | 不能按 DOI prefix 或 publisher 字符串直接猜生产 route |
| Publisher Profile | 版本化 origin allowlist、stable ID、capability、policy/session group | 不能把上游 profile、selector 或模板整体复制为已核实 catalog |
| Persistent Browser context | operator-managed profile identity 与进程内 session broker | 不读取 Cookie DB，不导出 Cookie，不使用跨进程文件队列 |
| 页面状态分类 | login、entitlement、paywall、MFA、challenge 的安全有限状态 | 不自动绕过 CAPTCHA、Cloudflare 或 MFA，不自动选择机构 |
| 多路 PDF 捕获 | 已准入的 download、response、popup、viewer target | 不捕获任意 origin 的 PDF，不执行任意 JavaScript |
| Verification matrix | 统一证据包、fixture 与明确 production state | 不继承上游 success/failed/unsupported verdict |
| Health summary | 仅显示配置、readiness、action-required 的安全摘要 | 不检查 Chromium Cookie 数据库，不显示 profile 内容 |

### 3.2 可以评估实质移植，但必须逐项归属

以下文件只能提供待核实线索。若未来确需复制其中任何常量、selector、URL template、匹配表或算法表达，必须先在本文登记，然后再进入代码评审：

| 上游文件 | 可评估线索 | SciRetriever 后续任务 | 独立复核要求 |
| --- | --- | --- | --- |
| `publisher_profiles.py` | access key、origin、文章标识和 locator 线索 | P56-P69 | Provider 官方域名/产品资料与本项目 fixture |
| `institutional/publisher_profiles.py` | login/entitlement/page marker 线索 | P56-P68 | 排除 Tsinghua-specific selector，逐平台核实 |
| `publisher_pdf_router.py` | primary PDF 与 supplement 路由线索 | P56-P69 | 官方 URL/页面事实与资产归属 fixture |
| `publisher_access.py` | 有界页面动作和捕获线索 | P56-P68 | SciRetriever per-hop guard、预算和 cleanup 测试 |
| `browser_login.py` | 登录与人工介入状态线索 | P56-P68 | 不自动选机构、不自动 MFA、不读取 Cookie 内容 |
| `publisher_strategies.py` | response/download/popup 捕获线索 | P56-P68 | 删除任意 JS、反绕过、固定 sleep 和猜测 fallback |
| `session_broker.py` | session/risk 分组理念 | P55、P70 | 只允许 SciRetriever 的进程内 broker，不复制文件队列 |
| `profile_health.py` | 安全状态摘要理念 | P70、P71-P73 | 禁止读取 Cookie DB 或泄露 profile 内容 |
| `data/publisher_access_catalog.json` | Provider 覆盖范围线索 | P56-P70 | 每一项重新取得官方证据和 SciRetriever fixture |
| `data/publisher_browser_verification_matrix.json` | 证据字段和缺口表达线索 | P56-P70 | 不复用 verdict；不得引用个人运行环境为生产证据 |
| `data/institutional_identity_policy.json` | session/identity 风险线索 | P55-P70 | 删除机构身份和专属网络事实，重新证明分组 |

“清洁重实现”仍需在提交说明中指出参考过的抽象和独立证据，但只有确实复制或改写了上游表达时才登记为 Apache-2.0 实质移植。不能通过改名、改格式或机械转写把实质移植标成纯理念。

### 3.3 永久禁止迁移

以下能力和文件不属于 SciRetriever 的产品、安全或许可边界：

- `sources/scihub.py`、`sources/libgen.py`、Tor、embedded Tor、代理池和出口轮换；
- `flaresolverr.py`、`cloakbrowser_compat.py`、stealth、指纹补丁、人性化反检测、CAPTCHA/Cloudflare/MFA 自动绕过；
- `schools.py`、CARSI、WebVPN、EZProxy、`instsci` 和任何学校、机构或校园网络硬编码；
- Cookie JSON/Netscape 导入导出、profile Cookie 数据库读取或跨模块共享 Cookie；
- 任意页面 JavaScript、通用未知站点 selector、自动搜索/点击机构或无限页面发现；
- 跨进程文件队列 Browser broker；
- 固定 PDF 最小字节、页数或正文阈值；
- `_core/` 的 proprietary Cython 源、预编译扩展或其反向工程结果；
- 根据 DOI prefix、publisher 文本或未核实历史结果直接猜生产 route。

## 4. 上游 verification matrix 的证据边界

上游 JSON 自述的 `browser_verified_count = 19`、APS `unsupported`、Elsevier `failed / challenge_or_viewer_timeout` 只描述 ScanSci 自己的运行环境。相关记录包含 CloakBrowser、Tsinghua SSO/2FA 和机器本地 `downloads\\...` 路径；SciRetriever 仓库中没有它引用的完整原始运行证据，也没有复现这些个人机构会话。

因此：

- ScanSci 的成功项不能直接进入 production registry；
- ScanSci 的失败或 unsupported 项也不能替代 SciRetriever 的独立审查；
- 未经现场授权的页面画像最多是 `fixture-verified`，证据不足则为 `unsupported`；
- production-ready 必须满足 P55 统一接入门，并以官方事实、SciRetriever 离线 fixture 和必要的明确授权验证为依据；
- fixture 只能证明规则和安全状态机，不证明用户账号 entitlement、真实站点稳定性或成功率。

## 5. 后续迁移登记流程

P56-P70 每个 Provider 都应先完成统一证据包，再决定 public/API-only、Browser `fixture-verified` 或 `unsupported`。若实施者准备从上游实质移植材料，顺序固定为：

1. 固定上游 repository 与 commit，并定位精确文件、对象或行；
2. 判断是理念清洁重写，还是源码/数据/常量的 `copy` 或 `adapt`；
3. 对 `copy`/`adapt` 保留 Apache-2.0 许可证和版权，标出 SciRetriever 修改；
4. 在根 `NOTICE` 和本文复制登记表补充逐文件 provenance；
5. 独立核实官方域名、产品、访问政策、速率、ID、origin、状态 marker 和资产归属；
6. 增加不连接真实 Provider、凭据或个人 profile 的离线 fixture；
7. 只有 production 对象图、配置、状态和测试闭环后才允许 production-ready。

如果不能完成其中任一步，保留为线索、fixture-only 或 unsupported；不能用猜测填补 selector、速率、风险组或 session group。
