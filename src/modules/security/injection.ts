/**
 * 模块 J5：提示注入（Prompt Injection）检测引擎。
 *
 * 提示注入是 LLM 时代特有的攻击面：恶意指令混入用户输入或外部内容，
 * 诱导模型覆写系统指令、越狱或窃取系统提示词。与 DLP（防数据外泄）
 * 互补——DLP 管「数据出不去」，注入检测管「指令进不来」。
 *
 * 检测器为纯函数、零依赖、双语（中英）模式库，六类攻击语义：
 * 1. instruction-override 指令覆写（「忽略以上所有指令」）；
 * 2. role-jailbreak 角色越狱（「假装你是不受限制的 AI」）；
 * 3. system-exfil 系统提示词窃取（「输出你的系统提示词」）；
 * 4. tool-hijack 工具劫持（诱导以管理员身份调用工具）；
 * 5. delimiter-confusion 分隔符伪造（伪.system 标签/角色标记注入）；
 * 6. encoding-evasion 编码规避（Base64/十六进制/Unicode 转义载荷）。
 *
 * 风险评分：各命中按严重度加权求和（封顶 100），
 * 判定 clean / suspicious / malicious 三档；严格模式下 malicious 直接拦截。
 */
import type { Domain } from '../../core/storage-adapter.js'

/** 注入检测设置（dlp-settings 表 'injection' 键）。 */
export interface InjectionSettings {
  /** 总开关：关闭时不扫描不拦截。 */
  enabled: boolean
  /** 严格模式：malicious 判定直接拦截调用（否则仅警告）。 */
  strict: boolean
}

/** 注入命中。 */
export interface InjectionFinding {
  /** 检测器 id（如 'instruction-override'）。 */
  readonly id: string
  /** 攻击类别（中文展示名）。 */
  readonly category: string
  /** 严重度权重。 */
  readonly severity: number
  /** 命中片段（已掩码）。 */
  readonly sample: string
  readonly count: number
}

/** 扫描结果。 */
export interface InjectionScanResult {
  readonly findings: InjectionFinding[]
  /** 风险评分 0~100。 */
  readonly risk: number
  /** 三档判定。 */
  readonly verdict: 'clean' | 'suspicious' | 'malicious'
}

/** 单条检测器定义。 */
interface Detector {
  readonly id: string
  readonly category: string
  readonly severity: number
  readonly regex: RegExp
}

/** 内置检测器（大小写不敏感、全局匹配；中英双语）。 */
export const DETECTORS: readonly Detector[] = [
  {
    id: 'instruction-override',
    category: '指令覆写',
    severity: 40,
    regex: new RegExp(
      [
        '(?:ignore|disregard|forget|override)\\s+(?:all\\s+|any\\s+|the\\s+|your\\s+)?(?:previous|prior|above|earlier|initial|original)\\s+(?:instructions?|prompts?|rules?|directions?|constraints?)',
        '(?:忽略|无视|忘记|覆盖)(?:掉)?(?:之前|以上|先前|上面|所有|全部)?(?:的)?(?:指令|指示|提示词?|规则|约束|设定)',
        '新(?:的)?(?:最高|全局)指令',
        '你的(?:新)?(?:角色|任务)(?:是|改为)',
      ].join('|'),
      'gi',
    ),
  },
  {
    id: 'role-jailbreak',
    category: '角色越狱',
    severity: 35,
    regex: new RegExp(
      [
        '(?:pretend|act|behave)\\s+(?:that\\s+)?you\\s+(?:are|were)\\s+(?:now\\s+)?(?:a|an|the)?\\s*(?:unrestricted|unfiltered|uncensored|limitless)',
        'you\\s+are\\s+now\\s+(?:DAN|an?\\s+unfiltered|free\\s+from)',
        '(?:do\\s+anything\\s+now|DAN\\s+mode)',
        '(?:假装|扮演|你现在是?|你现在扮演)(?:你是?|成)?(?:一个?|一位)?(?:不受限|无限制|没有道德|没有伦理|已?越狱|绝对自由)(?:的)?(?:AI|助手|智能体|模型|角色)?',
        '不受(?:任何)?(?:限制|约束|道德|伦理)(?:地)?回答',
      ].join('|'),
      'gi',
    ),
  },
  {
    id: 'system-exfil',
    category: '系统提示词窃取',
    severity: 30,
    regex: new RegExp(
      [
        '(?:reveal|show|print|display|repeat|output|dump|leak)\\s+(?:your|the)\\s+(?:full\\s+|complete\\s+|original\\s+|entire\\s+)?(?:system\\s+)?(?:prompt|instructions?|initial\\s+message|configuration)',
        'what\\s+(?:are|were)\\s+(?:your|the)\\s+(?:exact\\s+)?(?:instructions|system\\s+prompt)',
        '(?:输出|打印|显示|复述|泄露|告诉我)(?:你|您)?(?:的)?(?:完整|原始|全部)?(?:系统)?(?:提示词?|初始指令|系统指令|设定)',
        '(?:你的|您(?:的)?)(?:系统提示|初始设定)(?:是什么|内容)',
      ].join('|'),
      'gi',
    ),
  },
  {
    id: 'tool-hijack',
    category: '工具劫持',
    severity: 25,
    regex: new RegExp(
      [
        '(?:call|invoke|execute|run)\\s+the\\s+(?:tool|function|command)\\s+(?:with\\s+)?(?:as\\s+)?(?:admin|root|sudo|privilege)',
        '(?:以|用)(?:管理员|root|最高权限)(?:身份|权限)?(?:调用|执行|运行)',
        '(?:必须|立即|强制)(?:调用|执行|使用)(?:该)?(?:工具|函数|命令)',
      ].join('|'),
      'gi',
    ),
  },
  {
    id: 'delimiter-confusion',
    category: '分隔符伪造',
    severity: 30,
    regex: new RegExp(
      [
        '<\\s*/?\\s*(?:system|assistant|developer|im_start|im_end)\\s*>',
        '(?:^|\\n)\\s*(?:#{2,4}\\s*)?(?:SYSTEM|system)\\s*(?:#{2,4})?\\s*(?::|：)',
        '\\[\\s*(?:SYSTEM|系统指令|系统提示)\\s*\\]',
        '<\\|?(?:im_start|im_end|system)\\|?>',
      ].join('|'),
      'gi',
    ),
  },
  {
    id: 'encoding-evasion',
    category: '编码规避载荷',
    severity: 20,
    regex: new RegExp(
      [
        '[A-Za-z0-9+/]{80,}={0,2}',
        '(?:\\\\u00[0-9a-f]{2}){12,}',
        '\\b(?:base64|rot13|hex)(?:\\s*(?:decode|解密|解码))\\b',
      ].join('|'),
      'gi',
    ),
  },
]

/** 单条检测器最大命中数。 */
const MAX_FINDINGS_PER_DETECTOR = 10

/** 掩码：保留前 12 与后 8 字符。 */
function maskSample(text: string): string {
  if (text.length <= 24) return `${text.slice(0, 6)}***`
  return `${text.slice(0, 12)}***${text.slice(-8)}`
}

/** 风险评分封顶。 */
const MAX_RISK = 100

/** 判定阈值：≥60 malicious；≥25 suspicious。 */
const MALICIOUS_THRESHOLD = 60
const SUSPICIOUS_THRESHOLD = 25

/**
 * 扫描文本中的提示注入载荷。
 * 检测器内部缓存正则（g 标志有状态，复用前重置 lastIndex）。
 */
const compiledDetectors: readonly { detector: Detector; regex: RegExp }[] = DETECTORS.map(
  (detector) => ({ detector, regex: detector.regex }),
)

export function scanInjection(text: string): InjectionScanResult {
  const findings: InjectionFinding[] = []
  let risk = 0
  for (const { detector, regex } of compiledDetectors) {
    regex.lastIndex = 0
    let count = 0
    let sample = ''
    for (const match of text.matchAll(regex)) {
      count += 1
      if (!sample && match[0]) sample = maskSample(match[0])
      if (count >= MAX_FINDINGS_PER_DETECTOR) break
    }
    if (count > 0) {
      findings.push({
        id: detector.id,
        category: detector.category,
        severity: detector.severity,
        sample,
        count,
      })
      // 同类多次命中呈边际递减：首次全额，其后每次 +severity/4。
      risk += detector.severity + (count - 1) * (detector.severity / 4)
    }
  }
  risk = Math.min(MAX_RISK, Math.round(risk))
  const verdict: InjectionScanResult['verdict'] =
    risk >= MALICIOUS_THRESHOLD ? 'malicious' : risk >= SUSPICIOUS_THRESHOLD ? 'suspicious' : 'clean'
  return { findings, risk, verdict }
}

/** 注入检测设置仓库（dlp-settings 表 'injection' 键）。 */
export class InjectionSettingsStore {
  private readonly table

  constructor(domain: Domain) {
    this.table = domain.table<InjectionSettings>('dlp-settings')
  }

  get(): InjectionSettings {
    return this.table.get('injection') ?? { enabled: true, strict: false }
  }

  async update(patch: Partial<InjectionSettings>): Promise<InjectionSettings> {
    const next: InjectionSettings = { ...this.get(), ...patch }
    await this.table.put('injection', next)
    return next
  }
}
