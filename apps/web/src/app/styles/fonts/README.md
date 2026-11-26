# 离线字体

界面与阅读用到的字体全部随包离线交付，不请求外部字体服务。工作台由 Vite、登录页由 esbuild 为字体文件生成带 hash 的资源（登录页另有字体清单，未登录时只提供清单内文件）；`@font-face` 使用 `font-display: swap`。

## 拉丁字体

IBM Plex Sans 与 Source Serif 4 的可变字重拉丁子集，正常/斜体各一份，由 `../font-faces.css` 引入。

- IBM Plex Sans：npm `@fontsource-variable/ibm-plex-sans@5.3.0`（包 SHA-256 `0cdf43f91e27c4dcc53ffee829fd1ebe45c810c24684766bc1e5f5609d3ffc16`），取包内 `files/ibm-plex-sans-latin-wght-{normal,italic}.woff2`，文件字节与上游一致；原始字体由 IBM 发布，SIL OFL 1.1 许可证全文为 `ibm-plex-sans-OFL.txt`。
- Source Serif 4：npm `@fontsource-variable/source-serif-4@5.3.0`（2026-07-19 发布），原始字体由 Adobe 发布，SIL OFL 1.1 许可证全文为 `source-serif-4-OFL.txt`。

## 中文字体

思源黑体（Noto Sans SC）与思源宋体（Noto Serif SC）的可变字重版本，由 `../font-faces-cjk.css` 引入，分别放在 `noto-sans-sc/` 与 `noto-serif-sc/`。

- 来源：npm `@fontsource-variable/noto-sans-sc@5.3.1`（包 SHA-256 `95a11c5bbacd9995d94fc8cf964ee687307aacf20957ca6a4a16077519388163`）与 `@fontsource-variable/noto-serif-sc@5.3.1`（包 SHA-256 `ddadf818338639236bf2b968991856e2dfd788b2bdcb8aa62efe89161eb0a6b9`），2026-10-11 发布；原始字体由 Google 与 Adobe 发布，SIL OFL 1.1 许可证全文为 `noto-sans-sc-OFL.txt`、`noto-serif-sc-OFL.txt`。
- 取用范围：包内 `files/` 中按 `unicode-range` 切好的中文切片（`*-<序号>-wght-normal.woff2`，各 97 个）和 `latin-ext` 切片；文件字节与上游一致。`font-faces-cjk.css` 由包内 `index.css` 转写，只改了字体族名称、文件路径和格式声明，`unicode-range` 原样保留。
- 浏览器只下载页面上实际出现的字符所在的切片。两套切片合计约 10.4 MB。
- 更新方法：下载新版本的两个包，按上面的取用范围替换文件，并按同样规则重新转写 `font-faces-cjk.css`；记录新版本号与包 SHA-256。

## 楷体（机器写的话）

书本风格里机器写的话用楷体（ADR 0070）。由 `../font-faces-kai.css` 引入，文件在 `reader-kai/`，字体族名为 `Reader Kai`；拉丁文字不用它，用 Source Serif 4 的斜体（`../font-faces.css` 里以 `Source Serif 4 Italic` 的名字另登记了一次，声明为正体，这样旁边的楷体不会被浏览器倾斜）。

- 来源：霞鹜文楷 LXGW WenKai Medium 1.530（2026-10-18），本机文件 `LXGWWenKai-Medium.ttf`，SHA-256 `f4b8a34d1f838fe411540cb7c97b1c384ac9738a876c4104500bc42508b2312a`；原始字体由 LXGW 发布（基于 Fontworks 的 Klee One），SIL OFL 1.1，许可证全文与版权声明为 `reader-kai-OFL.txt`。
- 做了什么：按思源宋体的 `unicode-range` 切片逐片取子集，存成 WOFF2，共 97 片、约 4.0 MB；`font-faces-kai.css` 按同样的范围登记。浏览器只下载页面上实际出现的字符所在的切片。
- 改名的原因：原字体声明了保留字体名（“霞鹜”“LXGW”等）。取子集是修改，OFL 不允许修改后的版本沿用保留名，所以文件、字体内部的名称与 CSS 里的族名都叫 `Reader Kai`，版权与许可记录原样保留。
- 更新方法：取新版 `LXGWWenKai-Medium.ttf`，用 fontTools 按 `font-faces-cjk.css` 里思源宋体各切片的 `unicode-range` 重新取子集并改名；记录新版本号与 SHA-256。

[样式说明](../README.md)
