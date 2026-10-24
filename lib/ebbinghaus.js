// qq-memory 遗忘曲线算法（艾宾浩斯 Ebbinghaus 遗忘曲线）。
//
// 核心思想：记忆不会永久保留，而是随时间指数衰减；每一次「回忆（复习）」都会
// 增强记忆强度、把遗忘重新延后。这样既保留了「长期记忆 / 回顾上下文」的能力，
// 又能让不重要、很久没被提起的记忆自然淡出，从而**不再注入 prompt、节约 token**。
//
// 数学形式（艾宾浩斯的指数衰减近似）：
//   保持率  R = exp( -Δt / (strength × τ) )
//     Δt       = 距上次回忆的秒数（毫秒时间戳之差）
//     strength = 记忆强度（≥1，初始由「重要性」决定，复习时按 boost 放大）
//     τ        = 时间常数（可配置，默认 7 天；越大遗忘越慢）
//   当 R < threshold 时判定为「已遗忘」，不再注入上下文。
//
// 全部是**纯函数**，不碰 I/O，便于单测与复用。

/** 一条记忆的完整运行时结构（存储层负责读写，这里只关心计算）。 */
export const DEFAULT_PARAMS = Object.freeze({
  /** 时间常数 τ（毫秒）。默认 7 天。 */
  tauMs: 7 * 24 * 3600 * 1000,
  /** 遗忘阈值：保持率低于它即视为「已遗忘」。 */
  threshold: 0.15,
  /** 每次回忆（复习）的记忆强度放大系数。 */
  boost: 1.5,
  /** 记忆强度上限，防止无限增长导致永不忘。 */
  maxStrength: 10,
  /** 重要性对初始强度的加成系数。 */
  importanceWeight: 1.0,
});

/**
 * 计算一条记忆在 now 时刻的保持率 R ∈ (0, 1]。
 * @param {object} memory - 含 strength / lastRecalledAt
 * @param {number} now - 当前毫秒时间戳
 * @param {number} tauMs - 时间常数（毫秒）
 */
export function retention(memory, now, tauMs = DEFAULT_PARAMS.tauMs) {
  const strength = Math.max(1, Number(memory.strength) || 1);
  const tau = Math.max(1, Number(tauMs) || DEFAULT_PARAMS.tauMs);
  const dt = Math.max(0, now - Number(memory.lastRecalledAt || 0));
  return Math.exp(-dt / (strength * tau));
}

/** 判断一条记忆是否已经「遗忘」。 */
export function isForgotten(memory, now, params = DEFAULT_PARAMS) {
  return retention(memory, now, params.tauMs) < params.threshold;
}

/** 计算一条记忆当前的有效权重（用于排序：没忘且重要、刚提过的排前面）。 */
export function memoryWeight(memory, now, params = DEFAULT_PARAMS) {
  const r = retention(memory, now, params.tauMs);
  const importance = clamp(Number(memory.importance) || 0, 0, 1);
  // 保持率 × (0.5 + 重要性)：既看「还记得多牢」，又看「值不值得记」。
  return r * (0.5 + importance);
}

/**
 * 回忆（复习）一条记忆：强度增强、刷新时间戳、回忆次数 +1。
 * 返回新对象，不修改入参。
 */
export function reinforce(memory, now, params = DEFAULT_PARAMS) {
  const boost = Number(params.boost) || 1;
  const max = Number(params.maxStrength) || 1e9;
  return {
    ...memory,
    strength: Math.min(max, Math.max(1, Number(memory.strength) || 1) * boost),
    lastRecalledAt: now,
    recallCount: (Number(memory.recallCount) || 0) + 1,
  };
}

/**
 * 创建一条新记忆。初始强度 = 1 + importance × importanceWeight，
 * 即「越重要，一开始记得越牢、忘得越慢」。
 */
export function createMemory({ id, content, importance = 0.5, tags = [], scope = '*' }, now, params = DEFAULT_PARAMS) {
  const imp = clamp(Number(importance) || 0, 0, 1);
  const base = 1 + imp * (Number(params.importanceWeight) || 0);
  return {
    id: id || randomId(),
    content: String(content ?? '').trim(),
    tags: Array.isArray(tags) ? tags.map(String).filter(Boolean) : [],
    importance: imp,
    strength: Math.max(1, base),
    createdAt: now,
    lastRecalledAt: now,
    recallCount: 0,
    scope: String(scope ?? '*'),
  };
}

/** 过滤出「尚未遗忘」的记忆，并按有效权重降序排列。 */
export function recallableMemories(memories, now, params = DEFAULT_PARAMS) {
  return memories
    .filter((m) => m && !isForgotten(m, now, params))
    .sort((a, b) => memoryWeight(b, now, params) - memoryWeight(a, now, params));
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function randomId() {
  // 无 crypto 依赖的稳定随机 id（插件可能跑在受限运行期）。
  try {
    return globalThis.crypto?.randomUUID?.() ?? `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  } catch {
    return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  }
}
