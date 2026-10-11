# Sci-Hub 跳转、公共失败隔离与真实复验（2026-10-10）

## 目标与范围

根据用户要求，修复公共下载渠道故障阻断独立 API/Browser 的问题，并调查 `sci-hub.ru` 为何转到
`sci-net.xyz`、此前 502 是否代表拒绝访问。本次真实请求与文件下载在临时目录进行，使用项目真实
Network、Sci-Hub Source、Entry、Candidate spool、PDF 文件检查与正式 acceptance/publication。
验证库隔离于生产 catalog；未改写生产 630 篇文献/456 个 PDF 的既有事实，未执行批量重下载、
注册、登录、请求上传、个人配置修改或 Git commit。

## 确认的原因

1. **重定向来自远端。** 两篇 `10.1021/...` DOI 在 Sci-Hub 上收到真实 302，Location 为 Sci-Net 的同 DOI 页面。
   代码只按标准 HTTP 重定向跟随，并没有把 Sci-Net 写入镜像列表或猜测它的地址。
2. **502 不足以证明被拒绝。** 之前批量记录中 Sci-Net 43 次返回 502；本次同类页面恢复为 200。
   没有服务端日志，不能认定是账号、版权、封 IP 或请求频率问题。客户端只能确认当时网关未正常交付。
3. **公共故障被错误扩大。** 原 Entry 只推进 `exhausted`，公共层保留下来的 502 直接终止目标；
   前批 39 个最终 502 目标均没有进入 Elsevier/Wiley API 发现步骤。这个失败不能代表其它独立渠道不可用。
4. **PDF 链接被本地误拒。** Sci-Net 的 PDF iframe URL 带 `#view=FitH&navpanes=0`；旧解析器提取链接后，
   `safeLocator` 因 fragment 拒绝。fragment 只供阅读器显示，不发送给服务器。实际 src 有引号；
   调查初期因取证脚本没匹配等号周围空格而误判成“不带引号”，已纠正，最终代码没有因此扩张 HTML parser。
5. **旧备用入口已不适用。** `.kr` 根页面和两个新旧 DOI 入口都返回同一份 610 字节广告占位 HTML，
   没有 DOI 表单或 PDF 链接。当前版本从 builtin 移除 `.kr`，用户 custom 列表保持原值。

Sci-Net 首页自述为论文请求与共享平台；已上传文件可不注册访问。这是页面陈述，不把它解释成
所有 DOI 均有文件，也不引入动态请求/上传功能。详情见 [Configured Sci-Hub](providers/configured-sci-hub.md)。

## 实现范围

- 公共 HTTP 5xx（无限流反馈）或明确连接/请求失败、超时、响应中断带独立 fallback 许可；保持
  Public → API → Browser 次序。单篇和 cohort 均在后续渠道未取得 PDF 时保留原失败，不提交自动耗尽。
- 失败许可与正常“路线不适用”分别表达；冷却保留原失败范围，后续普通故障不能抹去早先的阻断性错误。
  限流导致的发现冷却也不允许换其它公共来源绕过。
- `401`、`429`、Retry-After、API 权限/认证/临时失败、Network 安全准入拒绝、取消、合同、存储与发布错误
  保留原边界；没有把任意异常改成“没找到文件”。
- 静态 PDF 链接在 URL 准入前删除 fragment，路径/query/origin 与请求时 DNS 检查保留。这是通用 URL
  归一化，没有 Sci-Net/论文特例。
- 服务定义新增可选 `serverErrorBackoffMs`，默认无 Retry-After 的 5xx 共享退避 30 秒；重定向按实际目的地
  反馈，排队目标共享同一 scope。退避超过单次等待预算时保留实际 HTTP 响应，不做必然超时的内部重试。
  本地退避不伪造远端 Retry-After。
- 更新已有 ADR 0015 §7、R3、用户指南与供应商说明；无依赖、数据库 schema 或持久配置格式变化。

## 真实结果

| DOI | Sci-Hub/Sci-Net 页面 | 实际 PDF 请求 | 正式结果 |
| --- | --- | --- | --- |
| `10.1021/acsomega.5c11075` | `.ru` 302 → Sci-Net 200，显示 uploaded | `/storage/...pdf` 返回 200、application/pdf、3,626,762 字节 | Entry 正式接纳并发布临时库主 PDF；文章身份 unverified |
| `10.1021/acs.chemmater.4c00597` | `.ru` 302 → Sci-Net 200，显示 uploaded | 页面声明的 `/storage/...pdf` 返回 404 | Sci-Hub 单来源未获得文件；不能说机构无权限，生产配置下其它独立渠道仍可尝试 |

成功文件 SHA-256：`23a8ec1d87a76540d03db765d2d7887da822fd548edadf613d746dd6e99ce446`。
正式接纳后重新读磁盘核对字节数、hash 和 PDF magic 均一致。主 PDF 位于隔离测试库，未计入生产库数量。
真实下载复验使用生产 HTTP 服务政策，两篇之间等待 30 秒，不运行整批任务、不启动真实模型。
API/Browser 后备成功由离线正式对象图测试验证，本次没有宣称真实模型后备链也已重测。

调查中曾在临时脚本把每个主机所有请求强制间隔 30 秒；它占用了生产 transport 的 30 秒单次等待预算，
造成两次超时。这是验证脚本额外约束产生的结果，不能用来解释旧批次 502。最终复验去除该脚本约束，
按生产访问政策运行；没有为让测试成功而放宽生产超时或准入。

## 验收与证据

直接回归覆盖公共 502 → API 入库、公共超时 → Browser 入库、后续未命中保留故障、单篇/cohort 一致性、
限流/认证/安全/存储边界、发现冷却、重定向后共享 5xx 退避、fragment 归一化与 mirror custom 保留。

- 初轮相关 6 文件 / 96 项通过；最终新增 builtin 与限流冷却回归包含在 Full。
- 首次 Full：4 个 Web 用例在 192 CPU 默认测试并行下超过各自 5 秒上限；失败均为 timeout。
  随后这 4 个 Web 文件与 3 个相关文件一起复核，7 文件 / 60 项全部通过。
- 最终 Full 使用 Vitest 支持的环境变量限制为最多 8 个 worker，保留全部测试与原超时：Quick、206 个测试文件 / 1,469 项通过，15 文件 / 39 项按既有条件跳过，最后 build 通过。命令为
  `VITEST_MAX_THREADS=8 VITEST_MIN_THREADS=1 VITEST_MAX_FORKS=8 VITEST_MIN_FORKS=1 pnpm full`。

脱敏取证目录：`/tmp/sciretriever-scihub-routing-20261010-ULmT6B/`。

- `probe.ndjson`：最初 302/200、landing hash 与远端响应。
- `pdf-markup.ndjson`：iframe 与阅读器 fragment 的实际形状。
- `mirror-check.ndjson`：`.kr` 根页面和旧 DOI 的相同占位页证据。
- `downloads-http-trace.ndjson`：真实 302 → 200 → 200/404、正式接纳结果。
- `downloads-production-policy.ndjson`：生产服务政策下的首次成功结果。
- `full.log`、`recheck.log`、`full-final.log`：首次 Full、失败复核与最终 Full。

日志和 PDF 未提交；没有读取或打印个人凭据、Cookie 或用户 config。早先 502 的服务端根因依然不可知；
本文确认的是重定向来源、本地错误、当前实际文件可用性和修复后的程序行为。
