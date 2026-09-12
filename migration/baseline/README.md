# TypeScript 迁移基线

本目录只保存不包含用户数据的仓库基线信息。它服务于迁移盘点，不代表 TypeScript 已实现，也不替代
`docs/architecture/` 中的产品和架构真相源。

基线建立于 2026-09-09，依据当前 Git `HEAD` 和版本控制中的活动文件生成。未读取用户 Catalog、Profile、
配置、凭据或文献资产，未访问真实 Provider、LLM、MinerU 或出版社。完整 Python Harness 的运行结果将在
单独的验证记录中写入；没有运行的检查保持明确的 `not-run`。

`../inventory.json` 记录完整机器清单；[盘点证据](../evidence/baseline/inventory.md)已经补充公开 API、Provider、
CLI、配置项、直接测试及当前用户旅程的精简映射。2026-09-10 又把迁移期间新增的 7 个活动 Python bridge
纳入清单，当前共 242 个模块。每个模块现在都有 `port`/`redesign` 等处置、消费者、task IDs、TS target、测试映射和
证据字段；161 个历史测试也有直接 TS 测试或历史 oracle 的明确原因。T001 的盘点已经冻结，后续功能完成度仍按
T010–T064 的直接证据判断，不能用文件或测试数量代替能力验收。
