# 01 路线与线索

状态：Completed。

## Outcome 与进入条件

同一 cohort 按 direct、publisher-api、general-api、public-web、Browser 推进，成功目标不继续后续来源。每个 API 有可解释定位依据，前面已取得的文件/文章入口可复用；一个无效 PDF URL 不吞掉 DOI 或其它文章入口。

进入条件：用户已批准整体顺序；保留当前公共来源回退修复、共享 Network 及 unverified 文件接纳合同。

## 责任与合同

Provider 就近拥有阶段、站点、专用标识和名字别名；Acquisition 拥有候选下载与临时响应观察；Entry 拥有分层调度、文章级线索和 Browser 入口。认证类别不再代替优先级。来源中性输入可选新增目标版本；URL 观测只在当前操作存在，不进入日志/数据库明文敏感定位。

## Tasks

- [x] 1.1 修订 ADR 0014/0015 及目标技术描述，明确五层默认顺序与原有故障边界，归档讨论；验收文档不再同时宣称旧顺序有效。
- [x] 1.2 增加阶段合同与静态定义，保留旧 source 接口兼容、同阶段配置顺序与不可用来源标记；测试 CORE/Unpaywall 同属 general-api 而认证方式不同。
- [x] 1.3 扩大 Direct 候选至明确 PDF 或 PDF pathname，排除明确补充材料/版本冲突和授权 API 地址；测试大写后缀、query、无后缀强线索、HTML 冒充与一次下载。
- [x] 1.4 让实际 HTTP 获取报告运行时响应证据，形成文件候选与文章入口的分离上下文。避免 HEAD、重复读取文件和匿名失败永久缓存。
- [x] 1.5 Entry 消费四个 locator 阶段，保持 cohort 屏障、结果分区、取消和失败保留；名称/URL/专用标识连接出版社 API，必要 DOI 定位不依赖先走全部公共来源。
- [x] 1.6 构造有序 Browser 入口，包含已有文章页、可信本次落地、DOI，以及受支持的 PMID/PMCID/arXiv 标准入口；按版本与来源筛选、去重，供 03 消费。旧单 start_url 调用保持有效。

## 集成、验证与退出

公开配置的来源选择继续生效；排序在阶段之间固定，阶段内以已有选择顺序为基线。publisher-api 阶段可将唯一出版社名称候选稳定前移，冲突不改变顺序，其它来源不删除，实际调用仍由文章级证据决定。元数据/资产 DB 格式不改。Root 导出、bootstrap 与直接调用者按必要修改同步。

```bash
pnpm exec vitest run apps/server/test/acquisition-*.test.ts apps/server/test/pdf-*.test.ts apps/server/test/tiered-acquisition.test.ts --maxWorkers=4
```

必须断言全部五层的请求顺序与一次发布；不可用/不适用有区别；public 暂时失败不伪造耗尽；API 限流不绕过；未知出版社仍有独立路线；原观察与现有资产保持不变。

退出条件：01 Tasks 及直接测试通过；03 获得完整有序入口，02 的批准别名能够作为弱候选被消费。恢复时保留当前操作失败证据，不把测试失败通过回退源文件或弱化断言消除。日志定位与实际结果补在本文件。

## 实施证据

2026-10-11 已完成以下定向离线验证；最终集成 Full 已通过，结果见 04 集成验收。

```bash
pnpm exec vitest run apps/server/test/pdf-acquisition-scheduler.test.ts apps/server/test/pdf-five-stage.test.ts
```

- 首次联合验证的 44 个测试全部通过。新增 SICI 回归后，Root 联合运行 source-locator 3 个、application-assembly 29 个、`pdf-five-stage.test.ts` 29 个，61/61 通过，日志为 `/tmp/sciretriever-entry-review-20261011.log`。`pdf-acquisition-scheduler.test.ts` 的 16 个测试此前已通过，未声称此次重新联合运行。两文件的定向 Prettier、ESLint 检查通过；本轮未以这些结果代替 Full。
- 五层分别成功时停止后续来源，反序 registry 仍按阶段推进；5 篇文献的 cohort 保留每层屏障和按输入索引发布的结果分区，目标版本传至所有 locator source 和 Browser。
- 别名配置经磁盘保存及 bootstrap 读取后，唯一名称候选实际影响 publisher-api 的尝试顺序；跨 Provider 冲突保持原序，错误名称无法使不适用 API 产生下载。DOI 首跳只解析一次，实际落地站点优先于名称推测；已有文章证据不会再次触发定位。
- 其它版本、补充材料站点不成为目标 API 的适用证据；PMID、PMCID、规范化 arXiv 标识可独立形成 Browser 入口。HTTP 404 只降低入口优先级，HTTP 502 的来源失败在 Browser 未交付时保留；每篇只调用一次 Browser delivery。
- DOI 首次响应为有效 PDF 时直接走统一接纳，跳过 API 与后续网页请求；HTML 响应复用后只请求静态 PDF 链接；403/404 缓存响应不重复 GET，仍可由 Browser 成功交付。成功解析的落地地址及跨层重复 locator 也只获取一次；HTTP 落地入口不会撞上 HTTPS 下载边界而中断 Browser。
- 首跳 PDF 用例新增合法 SICI DOI `10.1002/(SICI)1097-0258(19970615)16:11<1239::AID-SIM541>3.0.CO;2-8`，修复前实际复现已得到 PDF 却返回 `exhausted`：Browser DOI 准入接受尖括号，而 `DoiLandingSource` 使用更窄规则。Root 已统一 DOI helper，并按路径分段编码；修复后联合验证通过，回归从合同规范化后的元数据派生预期 URL，同时断言零重复 GET、零后续 API/Browser 和正式主 PDF 的 hash。
- 向候选 collector 和最终 acceptance 分别注入 `EIO`：错误原样抛出，无 API/Browser 回退，未误发布主 PDF。测试只使用合成 home/catalog、fake transport 与真实本地候选接纳，不访问真实网络、模型或凭据。
- 旧调度测试的 7 个失败断言已迁移到新契约：API 先于公共网页；401/429 仍阻止后续 Browser，公共 503 仍允许独立补救；DOI 首跳 302 在 API 前提供站点依据，首跳 429 阻止 API 与公共网页。原拒绝字节复用用例显式声明 Direct/publisher-api 阶段后单独复跑通过。

- 获取适配、DOI 首跳、五层与配置治理最终联合回归：14 个文件 / 233 项全部通过，日志 `/tmp/sciretriever-routing-targeted-final-20261011.log`。该批次包含 DOI 46 项、阶段/候选 9 项与完整 Entry 接纳；Full 仍单独执行。
