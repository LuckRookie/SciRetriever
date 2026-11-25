# CloakBrowser 接入注意事项

类型：外部事实
负责：CloakBrowser 分发、许可、签名与运行时行为
状态：现行；外部事实核对日期为 2026-08-22

本文记录已核对版本的外部事实，不证明当前项目构建、Publisher entitlement 或验证页通过率；项目的 binary/Profile 完整生命周期归[Browser 技术篇](../architecture/technical/08-browser-control.md#6-目标接口尚未实现)。

## 1. 已核对的版本与来源

| 项目                  | 已核对值                   | 证据边界                                                    |
| --------------------- | -------------------------- | ----------------------------------------------------------- |
| Python wrapper        | `cloakbrowser==0.5.8`      | PyPI 与 GitHub v0.5.8；wheel 只包含 Python 代码             |
| Playwright API        | `1.55.0`                   | 接入核对的 API 版本；vendor 声明 playwright>=1.40，没有上限 |
| Linux x64 binary      | `146.0.7680.177.5`         | 官方 older-free release                                     |
| vendor service origin | `https://cloakbrowser.dev` | license/download 源码常量与发布路径                         |

官方来源：

- [CloakBrowser v0.5.8 README](https://github.com/CloakHQ/CloakBrowser/blob/v0.5.8/README.md)
  与 [源码 tag](https://github.com/CloakHQ/CloakBrowser/tree/v0.5.8)；
- [PyPI `cloakbrowser` 0.5.8](https://pypi.org/project/cloakbrowser/0.5.8/)；
- [Chromium v146.0.7680.177.5 release](https://github.com/CloakHQ/CloakBrowser/releases/tag/chromium-v146.0.7680.177.5)；
- [wrapper MIT license](https://github.com/CloakHQ/CloakBrowser/blob/v0.5.8/LICENSE) 与
  [binary 独立许可](https://github.com/CloakHQ/CloakBrowser/blob/v0.5.8/BINARY-LICENSE.md)。

## 2. Wrapper 与 binary 分发和许可

`cloakbrowser` wheel 约 126 KiB，只包装启动、下载、许可和 humanization 行为；定制 Chromium
binary 不在 wheel 中。wrapper 使用 MIT License，binary 受单独条款约束。当前公开条款允许内部
抓取和研究，但禁止重分发、转售、重新打包、bundle/嵌入第三方产品；Hosted Browser、OEM、SaaS
或让第三方技术直接控制 Browser 的用途可能需要另行取得 vendor 授权。

公开材料在“最新 major 是否免费”上存在需要 vendor 澄清的张力：README 介绍最新版本可使用
GitHub key 且限制一个并发，binary license 的 version-specific 条款则把最新 major 与付费订阅联系。

## 3. 官方校验材料

v146 Linux x64 官方 archive 是 `cloakbrowser-linux-x64.tar.gz`。该 release 同时发布
`SHA256SUMS` 与 `SHA256SUMS.sig`；manifest 声明的 x64 SHA-256 为：

```text
4a12bcde95fa1bb1beef2b41ab5e5c27c36be78e3be3d0dac8c64d705216670e
```

wrapper 固定 Ed25519 公钥；release 还提供 GPG-signed tag 与 attestation。`ensure_binary()` 的返回值或版本目录存在本身不能证明已复核签名和 archive 字节。

## 4. Wrapper 生命周期与参数

`launch_persistent_context()` 不是一个只返回 executable path 的轻量 helper。v0.5.8 的同步实现会：

1. 自己调用 `sync_playwright().start()`；
2. 调用 `ensure_binary(...)`；
3. 调用 Playwright `chromium.launch_persistent_context(executable_path=...)`；
4. 包装 `context.close()`，在 Context 关闭后停止由它创建的 Playwright manager。

`launch_persistent_context()` 支持 `user_data_dir`、`headless`、`proxy`、`args`、`stealth_args`、`user_agent`、`viewport`、`locale`、`timezone`、`color_scheme`、`humanize`、`human_preset`、`human_config`、`license_key`、`browser_version` 等参数。

## 5. 默认身份与 Linux persona

wrapper 每次启动默认随机生成 `--fingerprint=<random 10000..99999>`。v0.5.8 在 Linux 上默认追加 `--fingerprint-platform=windows`；README 与 changelog 也说明 native Linux persona，以及 spoofed platform 与宿主一致时的稳定性。

## 6. Humanization 接缝

`humanize=True` 会 patch Page、Locator、Frame 和 ElementHandle 的 click/fill/type/hover/scroll/
check/select/press/drag 等动作。实现依赖 Playwright 私有 `_generated` 类型、Locator `_impl_obj`
字段和 CDP isolated world；这种 vendor 内部 CDP 是 humanizer 的实现细节，不是向 Acquisition 或
Agent 开放第二个控制器。

## 7. Playwright 与 Chromium 的网络行为

Playwright 不能保证 `context.route()` 观察到被 Service Worker 接管的请求。CONNECT 在建立隧道前只能核对 hostname、IP 与 port；透传 TLS 时无法检查加密流量中的 path、resource type、frame ancestry 或 capture source。

Chromium 的 `plugins.always_open_pdf_externally=true` 会影响 PDF plugin 展示，并将顶层 PDF 交给原生下载事件。

CloakBrowser 降低自动化表面，但不保证 Cloudflare 自动完成，也不改变文章 entitlement。

## 8. 依赖风险与可能更换

Owner 2026-11-25：之后可能要把 CloakBrowser 换掉。尚未决定换不换、换成什么、何时换；这一节记录原因，供做决定时用。

依赖它带来三项风险：

- **不能随程序分发。** 第 2 节的条款禁止重分发与 bundle。[ADR 0066](../architecture/decisions/0066-complete-program-or-failed-build.md) 要求必需部件随程序到位，所以 binary 只能由每台机器在安装时从 vendor 的官方来源下载。
- **安装受第三方牵制。** ADR 0066 把受控浏览器的 runtime 列为必需部件，取不到即安装失败。vendor 撤下 v146 的下载或改变它的条件时，新安装会失败，包括不使用受控浏览器这一级的使用者。v146 的下载能否长期可用没有确认过。
- **升级可能要付费。** 当前固定在 v146，属于 vendor 的 older-free release。第 2 节记录的条款把最新 major 与付费订阅联系；2026-11-25 检索到的二手摘要（PyPI 页面、文档镜像）进一步写成“v148 起下载需要有效的订阅”，这一点没有对照许可原文核对。浏览器长期不升级，被出版社网站识别为自动程序的可能会上升。

做决定前要先查清：

1. 对照 `BINARY-LICENSE.md` 的当前版本，确认各版本的使用与下载条件；
2. v146 的官方 archive 是否长期保留；
3. 换掉它要重做什么：[ADR 0016](../architecture/decisions/0016-cloakbrowser-fixed-identity-runtime.md) 把它定为唯一的生产 runtime，固定身份、Profile 迁移、Xvfb 有头窗口栈都围绕它设计，更换需要新的 ADR。
