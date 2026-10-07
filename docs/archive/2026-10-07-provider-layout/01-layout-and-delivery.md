# 01：可直接理解的供应商目录

Outcome：查看一家供应商目录即可找到静态定义和适配实现；注册器没有供应商专有协议分支；已有公共行为保持。

进入条件：上一轮治理已验收；本轮用户授权目录整理。责任边界：providers 是 adapter 集合，业务接口和事实所有者继续属于 Metadata/Acquisition，密钥由 Configuration 私有注入。

- [x] 1.1 拆分集中目录为共享静态合同、每家 definition 和统一 registry；将产品选择和网页 host 规则放回对应 definition。
- [x] 1.2 迁移 11 家元数据适配器、7 家 PDF 适配器以及对应 locator/record 解析；CORE/Elsevier/Wiley 授权实现分开，通用安全/结果逻辑保留共享 helper。
- [x] 1.3 更新所有调用方和包根导出，删除旧内部实现路径；核对公开符号集合不变，直接回归证明 URL、凭据、适用范围和限流没有改变。
- [x] 1.4 更新目录 README、治理/架构/入口说明和活动源码链接，检查生成目录残留不会进入包；执行 Quick、Full、diff 与文档链接验收。

验证：`pnpm exec vitest run apps/server/test/metadata-*.test.ts apps/server/test/acquisition-*.test.ts apps/server/test/provider-catalog.test.ts apps/server/test/source-locator-routing.test.ts apps/server/test/configuration-*.test.ts`；最终 `VITEST_MAX_FORKS=4 VITEST_MIN_FORKS=1 pnpm full`。

退出条件：所有结果有当前证据，Full 通过；不把“文件已移动”当作生产兼容已经验证。失败保留现有文件和日志，修复精确调用方，不保留多套影子实现或弱化测试。真实网络下载不是本轮验收范围，已有功能的环境/账户限制保持。

当前证据：25 文件 / 162 项直接测试通过；认证声明接线收尾后 4 文件 / 29 项通过。公开根导出前后均为 403 个名称，无增减。初次拆分对照原有 14 家定义和 18 个服务全部一致；后补的 PDF header/metadata format 声明来自既有组装代码，不增加用户配置。64 个旧内部路径的编译文件已精确移除，当前 456 个源码/测试/依赖文件冻结清单不变。首次 Full 仅格式门禁失败，修复调用方 import 格式后重新运行，不能计为已通过。

最终验收：`VITEST_MAX_FORKS=4 VITEST_MIN_FORKS=1 pnpm full` 退出 0，194 文件 / 1,334 项通过，15 文件 / 39 项条件跳过，Vitest 288.34 秒；Quick、构建、安装后公开入口与便携包测试通过。`git diff --check` 与当前文档链接检查通过。日志 `/tmp/sciretriever-provider-layout-20261007/full.log`；前序格式失败与主动中断日志保留，不计为通过。
