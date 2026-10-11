# 发现与 PDF 缺陷修复复验（2026-10-10）

本记录承接[主题与种子测试](topic-seed-live-validation-2026-10-10.md)及[PDF 测试](pdf-live-validation-and-issues-2026-10-10.md)。用户授权修复已暴露的问题并有界复验；原报告保留为修复前证据。本轮使用当前 TypeScript 生产对象图、正式 Configuration/Credential owner 和新的临时 catalog/资产目录，没有修改个人配置、原用户库或原资产。

## 修复内容

| 所属边界                                | 修复                                                                                                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Crossref / 主题发现                     | 标题与作者单位中的换行/回车规范化；不改 DOI 身份。Crossref 支持单边年份；Entry 对规范年份再检查，越界/缺失年份不进入有年份限制的结果，仍计入 raw scan |
| Europe PMC                              | PUB_YEAR 查询表达式、DOI/PMCID/EXT_ID+SRC 的正确 lookup、references/citations 的页序号语义、空年份；不把 DOI-only 引文绑定为种子的 Provider record    |
| Semantic Scholar                        | 引文 API 使用未加前缀的 paper fields；关系与内嵌 observation 的共享 provenance 字段保持一致                                                           |
| Metadata / Entry / Literature / Storage | 逐项转换并接纳引用目标；内嵌记录可在预算末端入库；必要 lookup 共用预算；重复边复用 ID、追加来源，边与支持原子提交；保留取消/部分失败前的有效事实      |
| Public → API                            | 已知授权服务提示不会匿名请求；支持旧 observations；已确认 DOI landing origin 在操作内交给已启用 API；仍保留限流/认证/网络失败屏障                     |
| Wiley                                   | 唯一 DOI 与 TDM/受信页面证据绑定；一次受控 ALM 跳转；目的域名与凭据转发域名分开，跨域剥离 token，不保存 opaque 下载地址                               |
| Elsevier                                | Article ID 放资源路径；消费 Article API 的 PII 提示；MAIN PDF 只读直接子字段，嵌套预览图片不干扰解析；取 object 文件后走正式 PDF 验收/发布            |
| 失败报告                                | 非成功 API 状态保留 HTTP 码；Browser 限流报告等待条件及可重试，Agent 停止带页面状态/HTTP 状态；runtime 缺失给出已支持的安装入口                       |

没有增加数据库 schema、依赖、出版社 Browser 脚本、模型分支或 PDF 身份拒绝门。Auto/Custom 选源保持原配置语义；测试中显式选入 Wiley/Elsevier，不能由凭据存在推导生产 Auto 会使用它们。

## 真实元数据与引用结果

主题为 `photoredox catalysis organic synthesis`，年份 2015–2025，Crossref 和 Europe PMC 各扫描 100 原始项。

| 用例                           | 本轮结果                                                                                                                                |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Crossref 100 条转换            | 100/100，修复前为 91/100；未出现展示文本控制字符错误                                                                                    |
| Europe PMC 100 条转换          | 100/100，年份均为 2025；修复前 97 条落在 2026                                                                                           |
| 主题结果范围                   | 199 条符合规范年份的结果，越界为 0；排除一条 Crossref 在线/纸本年份不一致的记录                                                         |
| `10.3762/bjoc.21.200` 参考文献 | 45 条目标与有向引用，正常完成                                                                                                           |
| 同篇重复执行                   | 仍为 45 条边，追加来源支持；Literature 和引用边没有重复增长                                                                             |
| PMID `41065217` 被引           | 4 条，方向正确                                                                                                                          |
| ACS 综述参考文献跨页           | scan budget 210，形成 70 条可接纳目标；到预算结束，无转换/分页失败；207 条关系原始项及 3 条 lookup 原始项合计 210                       |
| ACS 综述低预算被引             | scan budget 10，接纳 10 条目标，修复前扫描后无预算 lookup 导致 0 条                                                                     |
| Semantic Scholar 参考文献      | 中间复测遇到 HTTP 429；等待后一次有界重试取得并正式接纳 10 条目标，无 provenance 冲突。10 是本次 result_limit，不是供应商全部参考文献数 |

主题复验在本轮临时库上再次运行，因此报告中的 accepted/matched 分别是 1/198，不把 199 条都描述为新建。所有发现、引文和部分成功均保留可查询来源。关闭再打开只读查询，临时元数据库可读，333 条 Literature；此总数包含不同样本和之前部分成功，不等于主题结果数。

## 真实 PDF 与 Browser 结果

| 文献 / 路线                                 | 结果与证据                                                                                                                                                                                                                    |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wiley `10.1002/adsc.201800405`              | Public 403 后进入已选 API，TDM 302 → ALM 200；正式入库，6 页，2,608,738 字节，0 模型调用                                                                                                                                      |
| Elsevier `10.1016/j.mcat.2023.113549`       | Article FULL XML 200 → MAIN object PDF 200；正式入库，7 页，1,222,404 字节，0 模型调用                                                                                                                                        |
| RSC `10.1039/c6cc04636c`                    | 一次尝试 2 次模型调用后得到通用 flow-failed，未能从该次结果定位更细原因，不能当作修复成功。另一次有界复验进入平台限流，最终 `pdf-browser-rate-limited`，保留等待冷却的 action，`retryable=true`；没有 PDF，也没有改走其它路线 |
| Springer 章节 `10.1007/978-981-97-8205-5_3` | 20 次模型调用后 Agent 停止，报告 `LOGIN_REQUIRED (HTTP 200)`；没有 PDF。这次页面要求登录，不等于已证明机构无版权                                                                                                              |

两个新 PDF 通过 pdfinfo，关闭并以独立 QueryApplication 重开后重新流式计算 SHA-256，均与 catalog 一致；文章身份仍为 `unverified`。所有 acquisition 进程关闭后 temporary/native/staging/preparation/pending 字节计数为 0。Browser 使用已核实的固定 Cloak bundle、正常应用 Profile 和 `qiuzk/gpt-6-luna`，没有复制 Cookie/Profile、切换 IP 或配置额外代理绕过限制。

未重复上一轮已成功的 arXiv、Sci-Hub、ACS、MDPI、Nature、ChemRxiv 下载；本轮真实请求聚焦被修复的 Wiley/Elsevier 与待区分原因的 RSC/Springer。没有据此宣称所有出版社都可下载。

## 验证与证据位置

原始运行脚本、脱敏事件、报告与下载文件位于 `/tmp/sciretriever-fixes-live-20261010-omkDRT/`。这些是临时现场证据，不提交到仓库：

- `metadata-fixed-results.json`：主题、Europe PMC 引用、重复与预算复验；`s2-final-results.json`：限流恢复后的 Semantic Scholar 结果。
- `pdf-results.json`：首次正式 Wiley 与 Browser 尝试；`elsevier-fixed-results.json`：最终 Elsevier 正式结果；`rsc-diagnostic-results.json`：RSC 最后限流结果。
- `reopen.json`：关闭后只读重开、资产字节与 hash 验证。

离线测试新增了协议形状、空年份/显示文本、年份范围、预算末端接纳、lookup 交错计数、重复边/来源、事务回滚、取消/深度/结果限制、MAIN 节点与预览图片、旧 API 提示、受控跳转/跨域凭据剥离、落地 origin 传递及失败屏障、Browser 报告等回归。它们只用合成输入、fake 或 loopback，未访问真实凭据/Provider。

最终 **Full 通过**：203 个测试文件、1,380 项测试通过，15 个文件 / 39 项按既有条件跳过；Quick 与构建成功，退出码 0。日志 `/tmp/sciretriever-fixes-full-verified.log`。首轮默认并发 Full 中 4 个 Web 文件各有 1 个用例超过既有 5 秒超时；这 4 个文件单独复查为 6/6 通过。最终全量复验只通过 Vitest 已支持的环境变量将测试 worker 并发收紧到 4，不改变测试范围、超时、跳过规则或 Harness 步骤。中间一轮还发现两个新 Crossref fixture 缺少必需的 `message-type`，已补齐并单独验证 5/5 通过。

运行环境限制仍须如实保留：普通开发启动需显式提供已验证的 Cloak bundle，或使用携带 runtime 的 portable 包；本轮只改诊断，不改个人配置。RSC 限流和 Springer 登录页没有被绕过；本次 RSC 早先的通用 flow-failed 仍缺乏更细现场原因，未通过新增出版社补丁来掩盖。

最终 Full 使用的完整命令：

```bash
VITEST_MAX_FORKS=4 VITEST_MIN_FORKS=1 \
VITEST_MAX_THREADS=4 VITEST_MIN_THREADS=1 pnpm full
```
