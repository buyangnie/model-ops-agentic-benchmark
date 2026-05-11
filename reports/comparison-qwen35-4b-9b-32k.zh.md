# qwen3.5 4B/9B 32K goosed Agentic 对比报告

## 测试口径

- 运行方式：`goosed agent`，不是直接调用 Ollama。
- Provider：`custom_ollama_local`，OpenAI-compatible endpoint 指向 `http://127.0.0.1:11434/v1/chat/completions`。
- 上下文：32K。
- thinking：正常模式，不加 `/no_think`。
- 执行方式：模型逐个串行运行，不并行。
- 场景：FO Copilot 简化工单 MCP，单轮，最多 5 次工具调用。
- 超时：单场景 240 秒。
- harness 修正：使用 `/sessions/{id}/events` 订阅输出，`/sessions/{id}/reply` 触发回复；每个 session 先设置 name，避免自动标题生成干扰；超时后调用 cancel。

## 汇总

| 模型 | 通过场景 | Finish 场景 | 超时场景 | 工具成功率 | 总耗时 |
| --- | ---: | ---: | ---: | ---: | ---: |
| qwen3.5:4b-32k-harness | 0/5 | 0/5 | 5/5 | 18/18 | 1200000ms |
| qwen3.5:9b-32k-harness | 2/5 | 4/5 | 1/5 | 20/20 | 966497ms |

## 9B 场景结果

| 场景 | 结果 | Finish | 超时 | 工具调用 | 耗时 | 备注 |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| intake | 未通过 | 否 | 是 | 5/5 | 240000ms | 工具都调用成功，但最终状态未达成；存在并发写入覆盖风险。 |
| dispatch | 通过 | 是 | 否 | 4/4 | 190442ms | 状态达成，最终输出完成。 |
| followup | 基本完成但报告状态缺失 | 是 | 否 | 4/4 | 189686ms | 事件显示消息、todo、comment 工具都成功，并有最终文本；该 run 未捕获 finalState。 |
| no-action | 通过 | 是 | 否 | 2/2 | 131014ms | 状态达成，最终输出完成。 |
| closure | 未通过 | 是 | 否 | 5/5 | 215355ms | 工具都调用成功，但最终状态仍为 resolved；并发写入覆盖导致 close 状态被旧快照覆盖。 |

## 判断

4B 不满足最低可用线：全部超时，没有任何场景产生 Finish。它能理解工具 schema，也能执行部分工具，但不能稳定结束任务。

9B 明显更接近可用：5 个场景中 4 个能 Finish，2 个严格通过，工具调用全部成功。它的问题主要不在“不会用工具”，而在两个方面：

- 性能仍然很慢，单轮 2 到 4 分钟级别。
- 当前 MCP 状态文件写入对并发工具调用不够稳，9B 会一次性发多工具调用，容易触发读写竞争。

## 选型建议

当前结论：4B 不适合作为 goosed 工单 agentic 场景的最小可用本地模型；如果必须在 4B 和 9B 中选，应该继续基于 9B 做 harness 优化。

下一步建议不是直接放弃 9B，而是修 harness：

- MCP 写状态改成基于最新 state 的字段级合并，避免并发旧快照覆盖新状态。
- 或在 provider request params 中尝试关闭 parallel tool calls。
- 保持 32K，继续用短指令和简单枚举入参。
- 修完后重跑 9B；如果 9B 能稳定 4/5 或 5/5 通过，再判断是否是本机最小可用模型。
