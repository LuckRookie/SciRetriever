# 按供应商组织适配代码

状态：Completed。用户明确要求每个 Provider 独立目录，统一接口与注册；这是上一轮供应商治理完成后的结构整理。基线 HEAD `dd2df24`，保留整个已有未提交工作树。

## 目标、边界与授权

依据 ADR 0012/0014、现有窄能力接口及用户本轮目录授权，将静态定义和真实协议实现收拢到 `apps/server/src/providers/<provider>/`。该目录是外部适配代码集合，不新增核心业务模块：Metadata 拥有搜索/observation，Acquisition 拥有候选接纳/发布，Network 拥有限流，Configuration 拥有用户配置与凭据。

保留包根公开导出、配置选择键、来源顺序、网络政策和存储语义。只迁移内部路径，不迁移真实数据、不调用真实 Provider、不改变个人配置，不执行 Git 写操作。

## 结果与恢复

| 结果块 | 输出与验证 | 状态 |
| --- | --- | --- |
| [01](01-layout-and-delivery.md) | 各家 definition/metadata/acquisition/locators，中央注册、调用方和直接测试同步；Full 验收 | Completed |

主要风险是漏改包根导出、内部动态 import、文档路径、旧构建文件与循环依赖。通过公开导出集合对照、TypeScript、直接行为测试、安装后测试和 Full 验证。新增目录只含源码，凭据和运行配置仍由原 owner 管理。

临时证据：`/tmp/sciretriever-provider-layout-20261007/`。恢复时核对此计划、当前工作树及 `moves.json`；不能从 HEAD 重置带有此前修复的源文件。迁移脚本只在临时目录，不进入产品。定向回归、公开导出核对和文档链接检查已完成。最终 Full 退出 0：194 文件 / 1,334 项通过，15 文件 / 39 项条件跳过；格式、lint、源码与测试类型、构建及安装后入口验证通过。456 个冻结源码/测试/依赖文件全部一致，64 个退休编译文件未重新出现。证据为 `full.log`、`source-manifest.json`、`accepted.json`。

审查修正：首次 Full 在格式门禁失败；格式修复后的运行因包根导出被自动重排而主动中断（130）。恢复迁移前的无关导出顺序，仅修改 16 组必要导出声明；最终 Full 重新运行，前序日志不计为通过。

最终交接：每家 definition 与实际 metadata/acquisition 适配同目录，registry 仅汇总和通用查询。没有新增依赖、用户配置字段、schema 或数据迁移；包根 403 个导出名称保留，旧内部路径不保留影子转发。未调用真实 Provider/模型，未修改个人配置或凭据，未执行 Git 写操作。已有外部账户额度和 Browser 子资源政策限制不因目录迁移而宣称解决。

[上级目录](../README.md) · [项目 README](../../../README.md)
