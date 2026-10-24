# qq-memory

给 DeepSeek Harness（DSH）加「长期记忆 + 遗忘曲线」的插件：让 AI 能记住跨会话的事、按需回顾上下文，同时用艾宾浩斯遗忘曲线让旧记忆自然淡出——**忘掉的、不重要的记忆不再注入 prompt，从而节约 token**。

> 名字里的 `qq` 只是它最初诞生的场景（QQ 机器人），插件本身是**通用的长期记忆插件**，适用于任何 DSH 应用（聊天机器人、助手、Agent 等）。

## 特性

- **长期记忆**：AI 用 4 个工具自己决定「什么值得记住 / 什么时候回忆 / 什么时候忘掉」。
- **遗忘曲线**：每条记忆有强度，按 `R = e^(−Δt / (strength × τ))` 衰减；越重要初始越牢、每次回忆都会增强、久未提及自然遗忘。
- **自动注入 + 省 token**：每次模型调用前，只把「尚未遗忘、按权重排序」的前 N 条记忆拼进 system prompt；忘掉的、不重要的、过长的都被过滤或截断。
- **按会话隔离**：全局记忆（角色设定、长期偏好）所有会话共享；会话记忆按 session 隔离，互不串扰。
- **零外部依赖**：唯一依赖 `@deepseek-ai/schemastery`（DSH 自带）；存储只用 Node 内置 `fs`，落盘为单个 JSON 文件。

## 安装

发布到 npm 后：

```bash
dsh plugin --profile web add qq-memory
```

安装完重启 DSH（`dsh web`）即可生效。本地开发/试用也可用 link 方式：

```bash
dsh plugin --profile web add -w link:/path/to/qq-memory
```

## 配置

可在 DSH 设置面板的 `qq-memory` 命名空间里改（无需重挂载），或用环境变量覆盖。

| 参数 | 默认 | 说明 |
|---|---|---|
| `tauDays` | 7 | 遗忘半衰期（天），越大忘得越慢 |
| `threshold` | 0.15 | 遗忘阈值：保持率低于它即视为「已遗忘」 |
| `boost` | 1.5 | 每次回忆的强度放大系数 |
| `maxItems` | 10 | 注入上下文的最大记忆条数 |
| `maxChars` | 200 | 单条记忆注入的最大字数 |

对应环境变量：`QQ_MEMORY_TAU_DAYS` / `QQ_MEMORY_THRESHOLD` / `QQ_MEMORY_BOOST` / `QQ_MEMORY_MAX_ITEMS` / `QQ_MEMORY_MAX_CHARS`。

## 工具

| 工具 | 作用 |
|---|---|
| `qq_memory_remember` | 记住一条长期记忆（含 `content` / `importance` / `tags`），相似内容自动去重合并 |
| `qq_memory_recall` | 按关键词回忆记忆；命中会「复习」这些记忆，让它们忘得更慢 |
| `qq_memory_forget` | 主动遗忘一条已过时的记忆 |
| `qq_memory_list` | 列出当前尚未遗忘的记忆（含 id、内容、标签） |

## 存储位置

默认存到 `~/.dsh/qq-memory/memories.json`，可用环境变量 `QQ_MEMORY_DIR` 覆盖（便于测试与迁移）。

## 工作原理

1. **记**：`remember` 创建记忆，初始强度 `1 + importance`（越重要记得越牢）。
2. **淡**：保持率按艾宾浩斯指数衰减，跌破 `threshold` 即遗忘，不再参与注入。
3. **复习**：每次 `recall` 命中，强度 × `boost`、时间戳刷新——复习让记忆忘得更慢。
4. **注入**：装配 system prompt 时，取「未遗忘 + 全局 + 本会话」的记忆，按有效权重排序，截断到 `maxItems` / `maxChars`。

## License

MIT
