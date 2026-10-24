// qq-memory 记忆存储：JSON 持久化 + 遗忘曲线应用。
//
// 存到 <dir>/memories.json（默认 ~/.dsh/qq-memory/，可用环境变量 QQ_MEMORY_DIR 覆盖，
// 便于测试与迁移）。DSH 是单进程运行所有插件，所以这里用「内存缓存 + 同步写盘」
// 即可，不做跨进程锁。
//
// 每条记忆带 scope：
//   '*'            全局记忆（角色设定、长期偏好，所有会话共享）
//   <sessionId>    会话记忆（某个群/私聊的专属记忆，由 agent.id 即 session id 标识）
//
// 注入上下文时，一个会话看到的是「全局记忆 + 自己的会话记忆」两份合并。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  DEFAULT_PARAMS,
  createMemory,
  recallableMemories,
  reinforce,
  isForgotten,
} from './ebbinghaus.js';

const VERSION = 1;

function defaultDir() {
  if (process.env.QQ_MEMORY_DIR) return process.env.QQ_MEMORY_DIR;
  return path.join(os.homedir(), '.dsh', 'qq-memory');
}

export class MemoryStore {
  constructor(options = {}) {
    this.dir = options.dir || defaultDir();
    this.params = { ...DEFAULT_PARAMS, ...(options.params || {}) };
    this.file = path.join(this.dir, 'memories.json');
    this.memories = [];
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        // 兼容早期「纯数组」格式
        this.memories = data;
      } else if (data && Array.isArray(data.memories)) {
        this.memories = data.memories;
      }
    } catch {
      this.memories = [];
    }
  }

  save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, updatedAt: Date.now(), memories: this.memories }, null, 2), 'utf8');
      fs.renameSync(tmp, this.file);
    } catch {
      // 写失败不致命：记忆只是「这一轮没落盘」，下次仍可正常工作。
    }
  }

  /** 新增一条记忆。内容与已有记忆高度相似时做简单去重（避免 AI 反复记同一件事）。 */
  remember({ content, importance = 0.5, tags = [], scope = '*' }) {
    const text = String(content ?? '').trim();
    if (!text) return { ok: false, error: '记忆内容不能为空' };
    const now = Date.now();

    const dup = this.memories.find((m) => {
      if (m.scope !== scope) return false;
      const a = String(m.content ?? '').trim();
      return a === text || (a.length > 4 && text.includes(a)) || (text.length > 4 && a.includes(text));
    });
    if (dup) {
      // 重复记忆：不新建，而是「复习」它并略提升重要性。
      Object.assign(dup, reinforce(dup, now, this.params), {
        importance: Math.max(dup.importance, Number(importance) || 0),
        tags: [...new Set([...dup.tags, ...(Array.isArray(tags) ? tags.map(String) : [])])],
      });
      this.save();
      return { ok: true, id: dup.id, merged: true };
    }

    const mem = createMemory({ content: text, importance, tags, scope }, now, this.params);
    this.memories.push(mem);
    this.save();
    return { ok: true, id: mem.id, merged: false };
  }

  /** 回忆：按关键词/标签匹配未遗忘记忆，命中则触发「复习增强」。 */
  recall({ query, scope }) {
    const q = String(query ?? '').trim().toLowerCase();
    const now = Date.now();
    const candidates = recallableMemories(
      this.memories.filter((m) => m.scope === scope || m.scope === '*'),
      now,
      this.params
    );

    let matches;
    if (!q) {
      matches = candidates;
    } else {
      const tokens = q.split(/\s+/).filter(Boolean);
      matches = candidates.filter((m) => {
        const hay = `${m.content} ${(m.tags || []).join(' ')}`.toLowerCase();
        return tokens.every((t) => hay.includes(t));
      });
    }

    // 命中即复习：增强强度、刷新时间（这是艾宾浩斯曲线的核心——复习让记忆忘得更慢）。
    if (matches.length > 0) {
      let changed = false;
      for (const m of matches) {
        const next = reinforce(m, now, this.params);
        Object.assign(m, next);
        changed = true;
      }
      if (changed) this.save();
    }
    return matches.map((m) => ({ id: m.id, content: m.content, tags: m.tags, importance: m.importance }));
  }

  /** 主动遗忘一条记忆（按 id 删除）。 */
  forget(id) {
    const before = this.memories.length;
    this.memories = this.memories.filter((m) => m.id !== id);
    if (this.memories.length !== before) {
      this.save();
      return { ok: true, removed: before - this.memories.length };
    }
    return { ok: false, error: '未找到该记忆' };
  }

  /** 列出某 scope 可见的未遗忘记忆（不含已遗忘）。 */
  list(scope) {
    const now = Date.now();
    return recallableMemories(
      this.memories.filter((m) => m.scope === scope || m.scope === '*'),
      now,
      this.params
    ).map((m) => ({ id: m.id, content: m.content, tags: m.tags, importance: m.importance, recallCount: m.recallCount }));
  }

  /**
   * 生成「注入上下文」用的记忆摘要。
   * 只取未遗忘记忆，按有效权重排序，限制条数与单条字数——这就是 token 节约的落点：
   * 忘掉的不注入、不重要的不注入、过长的截断。
   */
  snapshot(scope, options = {}) {
    const maxItems = Number(options.maxItems) || 10;
    const maxChars = Number(options.maxChars) || 200;
    const now = Date.now();
    const items = recallableMemories(
      this.memories.filter((m) => m.scope === scope || m.scope === '*'),
      now,
      this.params
    ).slice(0, maxItems);

    const lines = items.map((m) => {
      const text = String(m.content ?? '').trim();
      const clipped = text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
      const tags = (m.tags || []).length ? ` [${m.tags.join('/')}]` : '';
      return `- ${clipped}${tags}`;
    });
    return {
      items: items.map((m) => ({ id: m.id, content: m.content, tags: m.tags })),
      text: lines.join('\n'),
      count: lines.length,
    };
  }

  /** 清理「已遗忘」的记忆（可选：手动或定期调用，防止文件无限膨胀）。 */
  prune() {
    const now = Date.now();
    const before = this.memories.length;
    this.memories = this.memories.filter((m) => !isForgotten(m, now, this.params));
    const removed = before - this.memories.length;
    if (removed > 0) this.save();
    return { removed, remaining: this.memories.length };
  }
}

/** 单例（插件进程内共享一个 store）。 */
let instance = null;
export function getStore(options) {
  if (!instance) instance = new MemoryStore(options);
  return instance;
}
