# CloakBrowser 接入注意事项

> 最后核对：2026-08-22
>
> 性质：外部 Browser runtime 的易变事实与接入风险。产品选择以
> [ADR 0016](../architecture/decisions/0016-cloakbrowser-fixed-identity-runtime.md) 为准，目标技术边界以
> [Network](../architecture/technical/network.md) 与
> [Configuration](../architecture/technical/configuration.md) 技术文档为准。当前生产对象图已经切换为
> 唯一 CloakBrowser runtime；本文仍不证明任何 Publisher entitlement 或验证页一定能够自动通过。

秘密值、个人 Profile、Cookie、页面正文、截图、挑战 token、签名下载 URL、真实 Publisher
语料和 Browser binary 都不能进入本文或仓库。

## 1. 当前固定生产基线

| 项目 | 固定值 | 证据边界 |
| --- | --- | --- |
| Python wrapper | `cloakbrowser==0.5.8` | PyPI 与 GitHub `v0.5.8`；wrapper wheel 只包含 Python 代码 |
| Playwright API | `1.55.0` | SciRetriever 当前锁定版本；vendor 只声明 `playwright>=1.40`，没有上限 |
| Linux x64 binary | `146.0.7680.177.5` | 官方公开 free release；不是当前最新 Pro binary |
| 目标平台 | Linux x86_64 | 当前服务器平台；其它平台必须单独验证 |
| vendor service origin | `https://cloakbrowser.dev` | 官方 license/download 源码常量与发布路径 |

生产基线把 wrapper、Playwright API 和 binary 三者一起锁定并完成 characterization。不能因为
Python 依赖解析成功，就推断 wrapper 对未来 Playwright 私有 API 或未来 Chromium 仍然兼容。

官方来源：

- [CloakBrowser v0.5.8 README](https://github.com/CloakHQ/CloakBrowser/blob/v0.5.8/README.md)
  与 [源码 tag](https://github.com/CloakHQ/CloakBrowser/tree/v0.5.8)；
- [PyPI `cloakbrowser` 0.5.8](https://pypi.org/project/cloakbrowser/0.5.8/)；
- [Chromium v146.0.7680.177.5 release](https://github.com/CloakHQ/CloakBrowser/releases/tag/chromium-v146.0.7680.177.5)；
- [wrapper MIT license](https://github.com/CloakHQ/CloakBrowser/blob/v0.5.8/LICENSE) 与
  [binary 独立许可](https://github.com/CloakHQ/CloakBrowser/blob/v0.5.8/BINARY-LICENSE.md)。

## 2. Wrapper 与 binary 不是同一分发物

`cloakbrowser` wheel 约 126 KiB，只包装启动、下载、许可和 humanization 行为；定制 Chromium
binary 不在 wheel 中。wrapper 使用 MIT License，binary 受单独条款约束。当前公开条款允许内部
抓取和研究，但禁止重分发、转售、重新打包、bundle/嵌入第三方产品；Hosted Browser、OEM、SaaS
或让第三方技术直接控制 Browser 的用途可能需要另行取得 vendor 授权。

公开材料在“最新 major 是否免费”上存在需要 vendor 澄清的张力：README 介绍最新版本可使用
GitHub key 且限制一个并发，binary license 的 version-specific 条款则把最新 major 与付费订阅联系。
因此 SciRetriever 首轮只采用公开标记为 older free build 的 v146；v150、v151 或其它 Pro/latest
版本在 vendor/法务确认前不能成为默认承诺。

SciRetriever wheel、源码仓库、fixture 和构建产物都不得包含 binary。用户显式安装动作应从官方
渠道取得它；普通 Completion、`config status`、测试、Quick、Full 和 fresh-wheel 验收均不得隐式
下载或更新。

## 3. 官方校验链与 binary 生命周期

v146 Linux x64 官方 archive 是 `cloakbrowser-linux-x64.tar.gz`。该 release 同时发布
`SHA256SUMS` 与 `SHA256SUMS.sig`；manifest 声明的 x64 SHA-256 为：

```text
4a12bcde95fa1bb1beef2b41ab5e5c27c36be78e3be3d0dac8c64d705216670e
```

wrapper 固定 Ed25519 公钥。SciRetriever 的显式 installer 使用锁定 wrapper 的下载、签名和解压
原语，但自行保留本次实际 archive：先验证 detached signature 和 manifest version binding，再要求
签名 manifest 中的 archive digest、仓库固定 digest 与实际 archive SHA-256 三者相同，然后才解压。
缺少签名证据、同版本 archive 被替换、digest 漂移或只生成任意 bundle 都会 fail closed，不能把
`ensure_binary()` 或目录存在本身当成验证结果。项目不接受用户自定义 download URL、未签名
manifest、本地 executable override 或仅凭文件名/版本目录判断成功。公开 release 还提供 GPG-signed
tag 与 attestation，可作为维护者的第二层发布审查材料，但不能取代运行安装路径中的 Ed25519 与
archive digest 校验。

Configuration 只允许用户显式执行 install/update/rollback：下载到 owner-only staging，完成签名、
版本与 digest 校验后原子发布；任何失败保留当前已验证版本。安装 manifest 只保存 wrapper/binary
版本、平台、官方 digest/签名验证状态和核对时间，不保存 license key、下载 URL query、Profile
身份或环境指纹。普通运行必须显式使用已锁定 `browser_version`，并在进入 vendor wrapper 前完成
本地 presence/manifest 检查。普通 runtime lease 另外创建 owner-only 的一次性无凭据 cache view，
只把当前已验证版本目录呈现给 wrapper；该 view 不包含长期 root 中可能出现的 `license.key`、
`.license_cache`、Pro/latest marker 或其它 vendor 状态，并在 context 关闭后删除。wrapper 的
`ensure_binary()` 因而只能命中固定版本，不能在业务路径解析 cache-file credential、切换 Pro/latest
或隐式联网。

## 4. 真实生命周期接缝

`launch_persistent_context()` 不是一个只返回 executable path 的轻量 helper。v0.5.8 的同步实现会：

1. 自己调用 `sync_playwright().start()`；
2. 调用 `ensure_binary(...)`；
3. 调用 Playwright `chromium.launch_persistent_context(executable_path=...)`；
4. 包装 `context.close()`，在 Context 关闭后停止由它创建的 Playwright manager。

因此不能把它天真塞入一个已经自行 start/stop Playwright 的 stock engine，否则会出现两套 manager、
线程所有权不一致、重复 stop 或资源残留。目标 adapter 必须让 CloakBrowser 在同一个 engine thread
内拥有 manager/context 生命周期，再通过 SciRetriever 的中性 Process/Context/Page facade 向上提供
能力；CloakBrowser 和 Playwright vendor 类型不得越过 Network/Bootstrap。

`launch_persistent_context()` 支持 `user_data_dir`、`headless`、`proxy`、`args`、
`stealth_args`、`user_agent`、`viewport`、`locale`、`timezone`、`color_scheme`、`humanize`、
`human_preset`、`human_config`、`license_key`、`browser_version` 等参数。SciRetriever 只传当前
合同所需的显式值；不启用 geo-IP、代理轮换或任意扩展路径。唯一 Browser proxy 是当前 loopback
`BrowserConnectProxy`，它继续执行 URL/DNS/IP/host/TLS/预算和 Publisher permit；该 loopback
proxy 不改变服务器原始出口。

## 5. 固定身份与 Linux persona

wrapper 默认的 stealth 参数每次启动会随机生成：

```text
--fingerprint=<random 10000..99999>
```

若复用同一个 Cookie/历史 Profile 却每次更换 seed，就会形成“同一长期状态、不同设备身份”的内部
矛盾。SciRetriever 必须在新 Profile 初始化时一次生成 seed，把它保存在 owner-only identity
manifest 中，并在每次启动显式传入相同 `--fingerprint=<seed>`。不同 Profile 必须使用不同 seed；
seed 原值不能进入普通配置、credentials、日志、Report、Catalog、测试快照或文档。

v0.5.8 wrapper 在 Linux 上默认追加 `--fingerprint-platform=windows`。README 与 changelog 支持
“native Linux persona”这一概念，并说明 spoofed platform 与宿主一致时结果更稳定；SciRetriever
因此显式使用固定 seed、`--fingerprint-platform=linux`、Profile 语言偏好、`--lang=en-US`、
`timezone=UTC` 与 1920x1080 Xvfb，而不采用 wrapper 的随机 Windows persona。

2026-08-22 的 CBA64 本地实际验收使用程序创建的临时 Profile 和 v146 binary，连续三次完整
启动/关闭并证明：webdriver 为 false；UA/Client Hints/platform 为 Linux；plugins、完整 languages、
screen/window、WebGL、四类字体、locale/timezone 在三次启动间稳定；带有效期的 Cookie、
LocalStorage 与 IndexedDB 在第二、三次启动可见；不同新 Profile 的 seed 派生安全 hash 不同；
Profile lease 排他、显式删除有效，结束后没有遗留 Chromium、Xvfb 或 Browser thread。测试只比较
有界表面、布尔事实与 hash，不把 seed、Profile 路径或浏览数据写入仓库。旧 stock Profile 仍不能
被当前 binary 静默打开、复制、降级或修改。

## 6. Humanization 接缝

`humanize=True` 会 patch Page、Locator、Frame 和 ElementHandle 的 click/fill/type/hover/scroll/
check/select/press/drag 等动作。实现依赖 Playwright 私有 `_generated` 类型、Locator `_impl_obj`
字段和 CDP isolated world；这种 vendor 内部 CDP 是 humanizer 的实现细节，不是向 Acquisition 或
Agent 开放第二个控制器。

所有生产 click、scroll、wait 和未来获准的输入必须复用同一 patched Page/Locator。不得调用
`page._original`、新建裸 CDP session、直接 DOM click、任意 `evaluate()` 动作或另一个 Browser。
只读 DOM/locator 发现仍需在 SciRetriever 有界观察接口内。由于 human layer 使用 Playwright 私有
API，必须用锁定的 1.55.0 做动作 spy/characterization；未来升级 Playwright 时重复该门禁。

## 7. 环境、代理与已核验的 Network 边界

现有 headed-display helper 会复制进程环境。Cloak runtime 必须改为最小 child environment 或在
传递前删除 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 及小写等价项，并删除所有
`CLOAKBROWSER_*` 下载、cache、binary、update、license 环境变量。当前固定 older-free v146 的
显式安装和普通 launch 都不消费 license key；即使保留的 origin-bound `credentials.toml`
`[cloakbrowser]` section 已配置，status 也只报告 `reserved-not-used-by-pinned-free-binary`。未来若
另行审查 Pro/latest 版本线，secret 仍只能来自规范 origin `https://cloakbrowser.dev` 绑定的
credentials；当前路径始终拒绝环境或 cache-file fallback。

Playwright 明确不能保证 `context.route()` 观察到被 Service Worker 接管的请求。loopback CONNECT
只能在建立隧道前核对已批准的 hostname、IP 与 port；它透传 TLS，不能在加密流量内证明 reviewed
path、resource type、frame ancestry、article ownership 或 capture source。因此生产 runtime 固定使用
`service_workers="block"`。普通页面脚本、fetch、iframe 与 challenge 资源仍走可路由的页面网络栈；
不得把 CONNECT 写成能够检查 Service Worker 的 TLS 内部请求。

实际 characterization 还发现：v146 在默认固定 Linux persona 下暴露 5 个正常 PDF plugin；向
Profile 写入 `plugins.always_open_pdf_externally=true` 后该表面会降为 0，但 Chromium 会把顶层
PDF 交给原生 download/response 事件。2026-08-22 的 Springer 真实回归证明，试图用
`Route.fetch()/fulfill()` 在 Python 中代取顶层 PDF 会把 MIME 误标的 536-byte 非 PDF 当成候选；
因此最终 Cloak runtime 原子写入 external-PDF preference，并删除该 workaround。普通顶层 PDF、
服务器 attachment 和页面生成的本地 blob download 都只从 Chromium 原生事件捕获，继续经过
query-free capture guard、请求/字节预算与文章清理，不由 Python 再发一条 PDF HTTP 请求。

截至该日期，旧 Publisher-specific 执行器的离线 unit/实际 fixture 已证明固定 Linux persona、
humanized click/Locator seam、共享 process/context、CONNECT、Cookie、redirect、iframe、JS fetch、
popup、response、blob download、native PDF response、预算、timeout、取消和确定性清理。
2026-08-22 的固定九家真实串行 A/B 又
证明：stock 与 Cloak 各自只创建一个 process/context；Springer 两者都取得并验证 PDF；七家
Cloudflare Publisher 两者都加载 17 个受限资源且本地阻断为 0；IOP 当前两者都未交付，Cloak 对
未审核 PerfDrive 顶层导航 fail closed 而不破坏共享 runtime。Cloak 的可解释收益是 CBA64 已实测
的固定 Linux 身份、`webdriver=false`、稳定 Browser surface 和本轮完整 challenge 资源加载，
不是小样本下载成功率提升。runtime cutover、最终 Full 和使用同一构建产物的 fresh-wheel
R1-R8 已完成；九家逐家复核将当时的工程规则状态与服务器现场结果分开记录。SpringerLink 的
最终现场准入为 `ready`；ACS、AIP、Elsevier、IOP、Oxford、RSC、Science 和 Wiley 为
`deferred`。这些状态只描述旧执行器的固定样本，不是当前 `browser:generic` 的 route、页面策略
或成功率证据。当前通用执行器仍复用这里已经证明的 CloakBrowser runtime 基础，但由 Agent 选择
封闭动作，并由 Acquisition 独立验证 PDF 与目标文章归属。逐家历史依据见
[Publisher 访问矩阵](providers/publisher-access-matrix.md)。

CloakBrowser 降低自动化表面，但它不保证 Cloudflare 自动完成，也不改变文章 entitlement。

## 8. 升级与回退门禁

改变 wrapper、Playwright 或 binary 任一版本前：

1. 固定候选三元组、官方 release、签名 manifest、archive digest 与许可状态；
2. 在独立 owner-only staging 安装，不触碰当前 binary 或真实 Profile；
3. 重跑 manager/thread/close、humanized action、固定身份、Xvfb/字体、CONNECT 与本地 HTTPS 事件验收；
4. 用新建隔离 Profile 做经授权的极小串行 live 对照，不读取个人 Profile/Cookie；
5. 只有不回归已有成功链且具有可解释收益时，才原子更新 verified manifest；
6. 回退只能复用与旧 binary 明确兼容的 Profile；不能用较旧 Chromium 打开已经升级的真实 Profile。

任何版本若需要 vendor entitlement、Hosted/OEM 许可或无法证明 Profile 安全，Configuration 都应报告
明确不可用/需要新 Profile，而不是保留 stock runtime fallback、自动下载其它版本或放宽 Network
guard。

## 9. 本地生产准入门

生产 `CloakRuntimeManager` 只接受当前已核验的运行三元组：Linux `x86_64` 主机、
`cloakbrowser==0.5.8` wrapper 和 `playwright==1.55.0` API，配合本页表格中的
`146.0.7680.177.5` Linux x64 binary。Configuration 在 `status`、显式安装/更新/回退以及
runtime lease 前使用本地 `sys.platform`、机器架构和 `importlib.metadata` 版本信息做 fail-closed
检查；不会导入 vendor downloader 或发起网络请求。检查失败时 `status` 只返回稳定的
`unsupported-platform` 或 `dependency-version-mismatch` reason，不包含路径、凭据或环境值。

注入 installer/verifier 的离线 fixture 不受这项生产主机门限制，从而可以在其它宿主平台上验证
缓存、manifest、签名证据和原子生命周期；这不是公开的第二 runtime，也不会放宽生产准入。
