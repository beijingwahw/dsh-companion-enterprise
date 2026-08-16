/**
 * 模块 G：多模型竞技场 —— 模型目录与推荐引擎。
 *
 * 目录 = 精选模型（DeepSeek / 头部国产旗舰 / 海外，手工准确率先验）
 *      + 全国产派生模型（自动来自 core/price/catalog.ts 价格目录，
 *        价格目录新增模型时竞技场自动跟随，无需手工维护）
 *      + 用户自定义模型（运行时存储，见 store.ts）。
 * 外部厂商需用户另行配置 API Key（arena-keys 加密存储）。国产模型均走
 * 各厂商的 OpenAI 兼容端点，模型 id 与价格目录一致，成本估算直接复用
 * 计价引擎。推荐引擎（G3）结合任务类型 + 预算 + 延迟要求 + 峰谷定价
 * 给出排序建议。
 */
import { CATALOG_TABLE, VENDORS, vendorOf } from '../../core/price/catalog.js'
import { isPeakTime } from '../../core/time.js'

/** 任务类型。 */
export type TaskType = 'code' | 'translation' | 'summarization' | 'reasoning' | 'general'

/** 模型目录条目。 */
export interface ArenaModelInfo {
  readonly id: string
  readonly label: string
  /** deepseek=官方 API；external=需另配 Key 的外部厂商。 */
  readonly provider: 'deepseek' | 'external'
  /** 外部厂商的 API 基址（provider=external 时）。 */
  readonly baseUrl?: string
  /** 各任务类型的准确率先验（0-1，来自公开评测的经验值）。 */
  readonly accuracyPrior: Readonly<Record<TaskType, number>>
  /** 典型延迟档位：fast / balanced / slow。 */
  readonly latencyTier: 'fast' | 'balanced' | 'slow'
  /** true=用户自定义模型（可删除，准确率先验取保守中值）。 */
  readonly custom?: boolean
}

/** 用户自定义模型记录（落盘于 arena-custom-models 表）。 */
export interface CustomModelRecord {
  /** 模型 id（同时作为 API 调用的 model 参数）。 */
  readonly id: string
  /** 展示名称。 */
  readonly label: string
  /** OpenAI 兼容 API 基址（如 https://api.example.com/v1）。 */
  readonly baseUrl: string
  readonly latencyTier: 'fast' | 'balanced' | 'slow'
  readonly createdAt: number
}

/** 自定义模型缺省准确率先验（无公开评测数据，取保守中值）。 */
const CUSTOM_ACCURACY_PRIOR: Readonly<Record<TaskType, number>> = {
  code: 0.85,
  translation: 0.85,
  summarization: 0.85,
  reasoning: 0.85,
  general: 0.85,
}

/** 将自定义模型记录转换为目录条目。 */
export function customModelToInfo(record: CustomModelRecord): ArenaModelInfo {
  return {
    id: record.id,
    label: record.label,
    provider: 'external',
    baseUrl: record.baseUrl,
    accuracyPrior: CUSTOM_ACCURACY_PRIOR,
    latencyTier: record.latencyTier,
    custom: true,
  }
}

/** 精选模型目录（准确率先验为公开评测经验值，仅用于推荐排序）。 */
const CURATED_MODELS: readonly ArenaModelInfo[] = [
  {
    id: 'deepseek-chat',
    label: 'DeepSeek V4-Flash（deepseek-chat）',
    provider: 'deepseek',
    accuracyPrior: { code: 0.88, translation: 0.9, summarization: 0.9, reasoning: 0.82, general: 0.88 },
    latencyTier: 'fast',
  },
  {
    id: 'deepseek-reasoner',
    label: 'DeepSeek V4-Pro（deepseek-reasoner）',
    provider: 'deepseek',
    accuracyPrior: { code: 0.94, translation: 0.92, summarization: 0.92, reasoning: 0.95, general: 0.93 },
    latencyTier: 'slow',
  },
  // ---- 头部国产模型（均为 OpenAI 兼容端点，模型 id 与价格目录一致） ----
  {
    id: 'glm-4.7',
    label: '智谱 GLM-4.7',
    provider: 'external',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    accuracyPrior: { code: 0.92, translation: 0.9, summarization: 0.9, reasoning: 0.91, general: 0.9 },
    latencyTier: 'balanced',
  },
  {
    id: 'glm-4.7-flash',
    label: '智谱 GLM-4.7-Flash（免费）',
    provider: 'external',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    accuracyPrior: { code: 0.84, translation: 0.85, summarization: 0.86, reasoning: 0.8, general: 0.84 },
    latencyTier: 'fast',
  },
  {
    id: 'kimi-k2.6',
    label: '月之暗面 Kimi K2.6',
    provider: 'external',
    baseUrl: 'https://api.moonshot.cn/v1',
    accuracyPrior: { code: 0.91, translation: 0.9, summarization: 0.91, reasoning: 0.9, general: 0.9 },
    latencyTier: 'balanced',
  },
  {
    id: 'qwen3-max',
    label: '通义千问 Qwen3-Max',
    provider: 'external',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    accuracyPrior: { code: 0.92, translation: 0.92, summarization: 0.91, reasoning: 0.92, general: 0.92 },
    latencyTier: 'balanced',
  },
  {
    id: 'qwen3-flash',
    label: '通义千问 Qwen3-Flash',
    provider: 'external',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    accuracyPrior: { code: 0.85, translation: 0.86, summarization: 0.86, reasoning: 0.82, general: 0.85 },
    latencyTier: 'fast',
  },
  {
    id: 'doubao-seed-2.1-pro',
    label: '豆包 Doubao-Seed-2.1-Pro',
    provider: 'external',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    accuracyPrior: { code: 0.9, translation: 0.91, summarization: 0.91, reasoning: 0.89, general: 0.91 },
    latencyTier: 'balanced',
  },
  {
    id: 'doubao-seed-1.6-flash',
    label: '豆包 Doubao-Seed-1.6-Flash',
    provider: 'external',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    accuracyPrior: { code: 0.83, translation: 0.85, summarization: 0.85, reasoning: 0.79, general: 0.84 },
    latencyTier: 'fast',
  },
  {
    id: 'minimax-m2.7',
    label: 'MiniMax M2.7',
    provider: 'external',
    baseUrl: 'https://api.minimaxi.com/v1',
    accuracyPrior: { code: 0.89, translation: 0.88, summarization: 0.89, reasoning: 0.88, general: 0.88 },
    latencyTier: 'balanced',
  },
  {
    id: 'ernie-4.5',
    label: '文心 ERNIE-4.5',
    provider: 'external',
    baseUrl: 'https://qianfan.baidubce.com/v2',
    accuracyPrior: { code: 0.88, translation: 0.9, summarization: 0.9, reasoning: 0.88, general: 0.9 },
    latencyTier: 'balanced',
  },
  {
    id: 'gpt-4o',
    label: 'GPT-4o',
    provider: 'external',
    baseUrl: 'https://api.openai.com/v1',
    accuracyPrior: { code: 0.93, translation: 0.93, summarization: 0.93, reasoning: 0.92, general: 0.93 },
    latencyTier: 'balanced',
  },
  {
    id: 'claude-sonnet-4-5',
    label: 'Claude Sonnet 4.5',
    provider: 'external',
    baseUrl: 'https://api.anthropic.com/v1',
    accuracyPrior: { code: 0.95, translation: 0.92, summarization: 0.93, reasoning: 0.94, general: 0.94 },
    latencyTier: 'balanced',
  },
]

// ---------------------------------------------------------------------------
// 网络权限白名单：与 manifest.json permissions.network.allowedOrigins 对齐
// ---------------------------------------------------------------------------

/**
 * 竞技场允许直连的 API 域名白名单（与 manifest.json allowedOrigins 对齐）。
 * 覆盖全部国产与海外主流厂商的 OpenAI 兼容端点及常见中转/聚合网关；
 * 自定义模型与 Key 覆盖的 baseUrl 必须落在本白名单内。
 */
export const ARENA_ALLOWED_ORIGINS: readonly string[] = [
  'https://api.deepseek.com',
  'https://open.bigmodel.cn',
  'https://api.moonshot.cn',
  'https://dashscope.aliyuncs.com',
  'https://ark.cn-beijing.volces.com',
  'https://api.minimaxi.com',
  'https://qianfan.baidubce.com',
  'https://api.openai.com',
  'https://api.anthropic.com',
  'https://generativelanguage.googleapis.com',
  'https://api.x.ai',
  'https://api.mistral.ai',
  'https://api.cohere.com',
  'https://api.lingyiwanwu.com',
  'https://api.stepfun.com',
  'https://api.baichuan-ai.com',
  'https://hunyuan.tencentcloudapi.com',
  'https://spark-api-open.xf-yun.com',
  // 第三方中转 / 聚合网关
  'https://openrouter.ai',
  'https://api.siliconflow.cn',
  'https://api.together.xyz',
  'https://api.groq.com',
  'https://api.deepbricks.ai',
  'https://api.302.ai',
  'https://oa.api2d.net',
  'https://api.closeai-asia.com',
  'https://aiproxy.ohmygpt.com',
]

/** 校验 baseUrl 的 origin 是否在白名单内。 */
export function isAllowedArenaOrigin(baseUrl: string): boolean {
  let origin: string
  try {
    origin = new URL(baseUrl).origin
  } catch {
    return false
  }
  return ARENA_ALLOWED_ORIGINS.some((allowed) => new URL(allowed).origin === origin)
}

// ---------------------------------------------------------------------------
// 全国产派生目录：自动覆盖价格目录中的全部国产模型
// ---------------------------------------------------------------------------

/** 厂商 → OpenAI 兼容 API 基址（派生模型调用入口）。 */
const VENDOR_BASE_URLS: Readonly<Record<string, string>> = {
  zhipu: 'https://open.bigmodel.cn/api/paas/v4',
  moonshot: 'https://api.moonshot.cn/v1',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  doubao: 'https://ark.cn-beijing.volces.com/api/v3',
  minimax: 'https://api.minimaxi.com/v1',
  ernie: 'https://qianfan.baidubce.com/v2',
}

/** 派生模型的缺省准确率先验（无逐模型评测数据，按厂商整体水平取经验值）。 */
const VENDOR_ACCURACY_PRIOR: Readonly<Record<string, Readonly<Record<TaskType, number>>>> = {
  zhipu: { code: 0.86, translation: 0.86, summarization: 0.87, reasoning: 0.85, general: 0.86 },
  moonshot: { code: 0.87, translation: 0.87, summarization: 0.88, reasoning: 0.86, general: 0.87 },
  qwen: { code: 0.87, translation: 0.88, summarization: 0.87, reasoning: 0.86, general: 0.87 },
  doubao: { code: 0.85, translation: 0.87, summarization: 0.87, reasoning: 0.84, general: 0.87 },
  minimax: { code: 0.84, translation: 0.84, summarization: 0.85, reasoning: 0.83, general: 0.84 },
  ernie: { code: 0.84, translation: 0.86, summarization: 0.86, reasoning: 0.84, general: 0.86 },
}

/** 派生模型缺省先验（厂商未在上表时使用）。 */
const DERIVED_FALLBACK_PRIOR: Readonly<Record<TaskType, number>> = {
  code: 0.83,
  translation: 0.84,
  summarization: 0.84,
  reasoning: 0.82,
  general: 0.84,
}

/** 模型名含这些关键词时判定为快速档（轻量/免费档）。 */
const FAST_TIER_KEYWORDS = ['flash', 'lite', 'turbo', 'speed', 'air']

/** 推断派生模型延迟档位：名字含轻量关键词 → fast，其余 balanced。 */
function deriveLatencyTier(modelId: string): ArenaModelInfo['latencyTier'] {
  const id = modelId.toLowerCase()
  return FAST_TIER_KEYWORDS.some((keyword) => id.includes(keyword)) ? 'fast' : 'balanced'
}

/**
 * 为给定模型 id 集合生成竞技场条目（最新模型自动导入的核心）：
 * 属于已知厂商且有 OpenAI 兼容端点、又未被精选目录覆盖的 id，
 * 自动生成条目。静态目录与实时定价表上新模型共用本函数。
 */
export function deriveModelsFromIds(
  modelIds: Iterable<string>,
  exclude: ReadonlySet<string>,
): ArenaModelInfo[] {
  const curatedIds = new Set(CURATED_MODELS.map((model) => model.id))
  const derived: ArenaModelInfo[] = []
  const seen = new Set<string>()
  for (const modelId of modelIds) {
    if (exclude.has(modelId) || curatedIds.has(modelId) || seen.has(modelId)) continue
    seen.add(modelId)
    const vendor = vendorOf(modelId)
    if (!vendor || vendor === 'deepseek') continue
    const baseUrl = VENDOR_BASE_URLS[vendor]
    if (!baseUrl) continue
    const vendorLabel = VENDORS[vendor]?.label ?? vendor
    derived.push({
      id: modelId,
      label: `${vendorLabel} ${modelId}`,
      provider: 'external',
      baseUrl,
      accuracyPrior: VENDOR_ACCURACY_PRIOR[vendor] ?? DERIVED_FALLBACK_PRIOR,
      latencyTier: deriveLatencyTier(modelId),
    })
  }
  return derived
}

/** 从内置价格目录派生全部国产模型条目（静态基线）。 */
function deriveDomesticModels(): ArenaModelInfo[] {
  return deriveModelsFromIds(Object.keys(CATALOG_TABLE), new Set())
}

/** 完整内置目录：精选模型 + 全国产派生模型。 */
export const ARENA_MODEL_CATALOG: readonly ArenaModelInfo[] = [
  ...CURATED_MODELS,
  ...deriveDomesticModels(),
]

/** 延迟档位 → 数值（用于推荐打分）。 */
const LATENCY_SCORE: Record<ArenaModelInfo['latencyTier'], number> = {
  fast: 1,
  balanced: 0.6,
  slow: 0.35,
}

/** 推荐请求。 */
export interface RecommendRequest {
  readonly taskType: TaskType
  /** 单次调用预算上限（元）；0=不限。 */
  readonly budgetPerCallCny: number
  /** 延迟要求：fast=尽量快 / balanced=均衡 / any=不限。 */
  readonly latencyRequirement: 'fast' | 'balanced' | 'any'
}

/** 推荐结果条目。 */
export interface Recommendation {
  readonly model: ArenaModelInfo
  readonly score: number
  readonly reason: string
}

/**
 * 模型推荐引擎（G3）：
 * 得分 = 准确率先验 × 0.6 + 延迟匹配 × 0.25 + 成本优势 × 0.15；
 * 峰谷感知：空闲时段在理由中提示低成本窗口。
 * models 传入完整候选列表（内置目录 + 用户自定义模型）。
 */
export function recommendModels(
  models: readonly ArenaModelInfo[],
  request: RecommendRequest,
  costPerCall: Readonly<Record<string, number>>,
  now: number = Date.now(),
): Recommendation[] {
  const offPeak = !isPeakTime(now)
  const candidates = models.filter((model) => {
    if (request.latencyRequirement === 'fast' && model.latencyTier === 'slow') return false
    if (request.budgetPerCallCny > 0) {
      const cost = costPerCall[model.id]
      if (cost !== undefined && cost > request.budgetPerCallCny) return false
    }
    return true
  })

  const costs = candidates.map((model) => costPerCall[model.id] ?? 0)
  const minCost = costs.length > 0 ? Math.min(...costs) : 0
  const maxCost = costs.length > 0 ? Math.max(...costs) : 0

  const scored = candidates.map((model) => {
    const accuracy = model.accuracyPrior[request.taskType] ?? 0.85
    const latencyScore =
      request.latencyRequirement === 'any'
        ? 0.8
        : request.latencyRequirement === 'fast'
          ? model.latencyTier === 'fast'
            ? 1
            : model.latencyTier === 'balanced'
              ? 0.5
              : 0.2
          : LATENCY_SCORE[model.latencyTier]
    const cost = costPerCall[model.id] ?? 0
    const costScore = maxCost > minCost ? 1 - (cost - minCost) / (maxCost - minCost) : 1
    const score = accuracy * 0.6 + latencyScore * 0.25 + costScore * 0.15
    const reason = buildReason(model, request, cost, offPeak, costPerCall)
    return { model, score, reason }
  })

  return scored.sort((a, b) => b.score - a.score)
}

/** 生成推荐理由文案。 */
function buildReason(
  model: ArenaModelInfo,
  request: RecommendRequest,
  cost: number,
  offPeak: boolean,
  costPerCall: Readonly<Record<string, number>>,
): string {
  const parts: string[] = []
  const accuracy = model.accuracyPrior[request.taskType] ?? 0.85
  parts.push(`该任务类型准确率先验 ${(accuracy * 100).toFixed(0)}%`)
  if (cost > 0) parts.push(`单次估算成本 ¥${cost.toFixed(4)}`)
  if (offPeak) {
    // 与最贵候选对比，突出空闲时段性价比。
    const others = Object.entries(costPerCall).filter(([id]) => id !== model.id)
    const pricier = others.filter(([, otherCost]) => otherCost > cost)
    if (pricier.length > 0) {
      const [topId, topCost] = pricier.sort((a, b) => b[1] - a[1])[0]
      if (topCost > 0 && cost > 0) {
        parts.push(
          `当前为空闲时段，成本仅为 ${topId} 的 ${(cost / topCost).toFixed(2)} 倍`,
        )
      }
    } else {
      parts.push('当前为空闲时段（峰谷定价优惠窗口）')
    }
  } else {
    parts.push('当前为高峰时段，可考虑延迟非紧急任务至空闲时段')
  }
  return parts.join('；')
}

/** 任务类型中文标签。 */
export function taskTypeLabel(taskType: TaskType): string {
  switch (taskType) {
    case 'code':
      return '代码生成'
    case 'translation':
      return '翻译'
    case 'summarization':
      return '摘要'
    case 'reasoning':
      return '推理'
    default:
      return '通用'
  }
}
