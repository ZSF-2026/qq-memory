// qq-memory 插件主体：给 QQ 机器人加「长期记忆 + 遗忘曲线」。
//
// 工作原理（三层）：
//   1) 记忆库：JSON 持久化（见 memory-store.js），每条记忆有强度/重要性/时间戳；
//   2) 遗忘曲线：艾宾浩斯衰减（见 ebbinghaus.js），旧记忆自然淡出、不再注入，
//      从而**节约 token**；
//   3) 两个入口：
//      · 自动注入 —— 用 systemPrompt.section 注册一段动态文本，每次模型调用前
//        把「尚未遗忘、按权重排序」的记忆摘要拼进 system prompt（AI 回顾上下文）；
//      · 主动工具 —— 用 tools.register 注册 4 个工具，AI 自己判断什么值得记住/
//        回忆/遗忘。
//
// 记忆 scope：以 agent.id（= DSH session id，对应一个 QQ 会话）为界；
// scope='*' 是全局记忆（角色设定、长期偏好），所有会话共享。
import z from '@deepseek-ai/schemastery';
import { DEFAULT_PARAMS } from './ebbinghaus.js';
import { MemoryStore } from './memory-store.js';

export const name = 'qq-memory';

// 依赖这两个服务：systemPrompt（注入记忆）、tools（注册记忆工具）。
export const inject = ['systemPrompt', 'tools'];

/**
 * 可热改配置（字段带 volatile 标记，DSH 设置面板可直接改、不必重挂载）。
 * 注意：与 qq-mode-console 同一坑 —— 这里用 `.extra('volatile', true)` 而不是
 * `.volatile()`，因为仓库钉的 schemastery 版本没有 `.volatile()` 语法糖。
 */
export const Config = z.object({
  tauDays: z.number().description('遗忘半衰期（天），越大忘得越慢').default(7).extra('volatile', true),
  threshold: z.number().description('遗忘阈值，保持率低于它即视为遗忘').default(0.15).extra('volatile', true),
  boost: z.number().description('每次回忆的记忆强度放大系数').default(1.5).extra('volatile', true),
  maxItems: z.number().description('注入上下文的最大记忆条数').default(10).extra('volatile', true),
  maxChars: z.number().description('单条记忆注入的最大字数').default(200).extra('volatile', true),
});

/** 从 config + 环境变量拼出运行时参数。 */
function resolveParams(config) {
  const env = process.env;
  const num = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    ...DEFAULT_PARAMS,
    tauMs: num(env.QQ_MEMORY_TAU_DAYS, config?.tauDays) * 24 * 3600 * 1000,
    threshold: num(env.QQ_MEMORY_THRESHOLD, config?.threshold),
    boost: num(env.QQ_MEMORY_BOOST, config?.boost),
    maxStrength: DEFAULT_PARAMS.maxStrength,
    maxItems: Math.floor(num(env.QQ_MEMORY_MAX_ITEMS, config?.maxItems)),
    maxChars: Math.floor(num(env.QQ_MEMORY_MAX_CHARS, config?.maxChars)),
  };
}

/** 拼一段 JSON schema（手写，避免依赖 dsh-tools 的 defineTool 引入解析差异）。 */
function obj(props, required = []) {
  return { type: 'object', properties: props, required };
}

/** 渲染一个结果对象为模型可见的简短文本。 */
function renderResult(args, value) {
  if (!value) return '（无返回）';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function apply(ctx, config) {
  const params = resolveParams(config);
  const store = new MemoryStore({ params });

  // ── 1) 自动注入：注册一段动态「长期记忆」section ─────────────────────────
  // text 是函数，每次装配 system prompt 时重新求值 —— 遗忘曲线让旧记忆淡出后，
  // 这里自动不再注入它们，token 随之降下来。
  ctx.systemPrompt.section({
    name: 'qq-memory:recall',
    order: 100,
    text: (assemblyCtx) => {
      const scope = assemblyCtx?.agent?.id ?? '*';
      const snap = store.snapshot(scope, { maxItems: params.maxItems, maxChars: params.maxChars });
      if (!snap.text) return '';
      return `【长期记忆（你之前记住的、还没忘的事）】\n${snap.text}\n【记忆使用】只在自然相关时提及，别硬聊旧事。`;
    },
  });

  // ── 2) 主动工具：让 AI 自己管理记忆 ──────────────────────────────────────
  const defs = [
    {
      name: 'qq_memory_remember',
      description:
        '记住一条长期记忆（你对某个人/话题/约定/偏好的印象）。重要且以后还会用到的事才记，别逐条记笔记。importance 0~1 越高记得越牢、忘得越慢。',
      parameters: obj(
        {
          content: { type: 'string', description: '记忆内容（一句具体、可复用的事实）' },
          importance: { type: 'number', description: '重要性 0~1，默认 0.5' },
          tags: { type: 'array', items: { type: 'string' }, description: '可选标签，如 ["偏好","约定"]' },
        },
        ['content']
      ),
      output: {
        schema: obj({ ok: { type: 'boolean' }, id: { type: 'string' }, merged: { type: 'boolean' }, error: { type: 'string' } }),
        render: renderResult,
      },
      async execute(args, exec) {
        const scope = exec?.agent?.id ?? '*';
        return store.remember({ content: args.content, importance: args.importance, tags: args.tags, scope });
      },
    },
    {
      name: 'qq_memory_recall',
      description:
        '回忆你记住的长期记忆。query 传关键词/主题（可多个词空格分隔），不传则返回全部未遗忘记忆。命中会「复习」这些记忆，让它们忘得更慢。',
      parameters: obj({
        query: { type: 'string', description: '关键词/主题，多个词空格分隔；不传返回全部' },
      }),
      output: {
        schema: obj({ matches: { type: 'array' } }),
        render: (args, value) => {
          const list = value?.matches;
          if (!Array.isArray(list) || list.length === 0) return '（没有匹配的记忆）';
          return list.map((m) => `- ${m.content}`).join('\n');
        },
      },
      async execute(args, exec) {
        const scope = exec?.agent?.id ?? '*';
        const matches = store.recall({ query: args.query, scope });
        return { matches };
      },
    },
    {
      name: 'qq_memory_forget',
      description: '主动遗忘一条记忆（它已经过时/不再适用时调用）。id 来自 qq_memory_list 或 qq_memory_recall 返回的记忆 id。',
      parameters: obj({ id: { type: 'string', description: '记忆 id' } }, ['id']),
      output: {
        schema: obj({ ok: { type: 'boolean' }, removed: { type: 'number' }, error: { type: 'string' } }),
        render: renderResult,
      },
      async execute(args, exec) {
        return store.forget(args.id);
      },
    },
    {
      name: 'qq_memory_list',
      description: '列出当前还没有遗忘的长期记忆（含 id、内容、标签）。',
      parameters: obj({}),
      output: {
        schema: obj({ items: { type: 'array' } }),
        render: (args, value) => {
          const list = value?.items;
          if (!Array.isArray(list) || list.length === 0) return '（暂无长期记忆）';
          return list.map((m) => `- [${m.id}] ${m.content}`).join('\n');
        },
      },
      async execute(args, exec) {
        const scope = exec?.agent?.id ?? '*';
        return { items: store.list(scope) };
      },
    },
  ];

  for (const def of defs) {
    ctx.tools.register(def);
  }
}
