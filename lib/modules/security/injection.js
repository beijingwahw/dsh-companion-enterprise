/** 内置检测器（大小写不敏感、全局匹配；中英双语）。 */
export const DETECTORS = [
    {
        id: 'instruction-override',
        category: '指令覆写',
        severity: 40,
        regex: new RegExp([
            '(?:ignore|disregard|forget|override)\\s+(?:all\\s+|any\\s+|the\\s+|your\\s+)?(?:previous|prior|above|earlier|initial|original)\\s+(?:instructions?|prompts?|rules?|directions?|constraints?)',
            '(?:忽略|无视|忘记|覆盖)(?:掉)?(?:之前|以上|先前|上面|所有|全部)?(?:的)?(?:指令|指示|提示词?|规则|约束|设定)',
            '新(?:的)?(?:最高|全局)指令',
            '你的(?:新)?(?:角色|任务)(?:是|改为)',
        ].join('|'), 'gi'),
    },
    {
        id: 'role-jailbreak',
        category: '角色越狱',
        severity: 35,
        regex: new RegExp([
            '(?:pretend|act|behave)\\s+(?:that\\s+)?you\\s+(?:are|were)\\s+(?:now\\s+)?(?:a|an|the)?\\s*(?:unrestricted|unfiltered|uncensored|limitless)',
            'you\\s+are\\s+now\\s+(?:DAN|an?\\s+unfiltered|free\\s+from)',
            '(?:do\\s+anything\\s+now|DAN\\s+mode)',
            '(?:假装|扮演|你现在是?|你现在扮演)(?:你是?|成)?(?:一个?|一位)?(?:不受限|无限制|没有道德|没有伦理|已?越狱|绝对自由)(?:的)?(?:AI|助手|智能体|模型|角色)?',
            '不受(?:任何)?(?:限制|约束|道德|伦理)(?:地)?回答',
        ].join('|'), 'gi'),
    },
    {
        id: 'system-exfil',
        category: '系统提示词窃取',
        severity: 30,
        regex: new RegExp([
            '(?:reveal|show|print|display|repeat|output|dump|leak)\\s+(?:your|the)\\s+(?:full\\s+|complete\\s+|original\\s+|entire\\s+)?(?:system\\s+)?(?:prompt|instructions?|initial\\s+message|configuration)',
            'what\\s+(?:are|were)\\s+(?:your|the)\\s+(?:exact\\s+)?(?:instructions|system\\s+prompt)',
            '(?:输出|打印|显示|复述|泄露|告诉我)(?:你|您)?(?:的)?(?:完整|原始|全部)?(?:系统)?(?:提示词?|初始指令|系统指令|设定)',
            '(?:你的|您(?:的)?)(?:系统提示|初始设定)(?:是什么|内容)',
        ].join('|'), 'gi'),
    },
    {
        id: 'tool-hijack',
        category: '工具劫持',
        severity: 25,
        regex: new RegExp([
            '(?:call|invoke|execute|run)\\s+the\\s+(?:tool|function|command)\\s+(?:with\\s+)?(?:as\\s+)?(?:admin|root|sudo|privilege)',
            '(?:以|用)(?:管理员|root|最高权限)(?:身份|权限)?(?:调用|执行|运行)',
            '(?:必须|立即|强制)(?:调用|执行|使用)(?:该)?(?:工具|函数|命令)',
        ].join('|'), 'gi'),
    },
    {
        id: 'delimiter-confusion',
        category: '分隔符伪造',
        severity: 30,
        regex: new RegExp([
            '<\\s*/?\\s*(?:system|assistant|developer|im_start|im_end)\\s*>',
            '(?:^|\\n)\\s*(?:#{2,4}\\s*)?(?:SYSTEM|system)\\s*(?:#{2,4})?\\s*(?::|：)',
            '\\[\\s*(?:SYSTEM|系统指令|系统提示)\\s*\\]',
            '<\\|?(?:im_start|im_end|system)\\|?>',
        ].join('|'), 'gi'),
    },
    {
        id: 'encoding-evasion',
        category: '编码规避载荷',
        severity: 20,
        regex: new RegExp([
            '[A-Za-z0-9+/]{80,}={0,2}',
            '(?:\\\\u00[0-9a-f]{2}){12,}',
            '\\b(?:base64|rot13|hex)(?:\\s*(?:decode|解密|解码))\\b',
        ].join('|'), 'gi'),
    },
];
/** 单条检测器最大命中数。 */
const MAX_FINDINGS_PER_DETECTOR = 10;
/** 掩码：保留前 12 与后 8 字符。 */
function maskSample(text) {
    if (text.length <= 24)
        return `${text.slice(0, 6)}***`;
    return `${text.slice(0, 12)}***${text.slice(-8)}`;
}
/** 风险评分封顶。 */
const MAX_RISK = 100;
/** 判定阈值：≥60 malicious；≥25 suspicious。 */
const MALICIOUS_THRESHOLD = 60;
const SUSPICIOUS_THRESHOLD = 25;
/**
 * 扫描文本中的提示注入载荷。
 * 检测器内部缓存正则（g 标志有状态，复用前重置 lastIndex）。
 */
const compiledDetectors = DETECTORS.map((detector) => ({ detector, regex: detector.regex }));
export function scanInjection(text) {
    const findings = [];
    let risk = 0;
    for (const { detector, regex } of compiledDetectors) {
        regex.lastIndex = 0;
        let count = 0;
        let sample = '';
        for (const match of text.matchAll(regex)) {
            count += 1;
            if (!sample && match[0])
                sample = maskSample(match[0]);
            if (count >= MAX_FINDINGS_PER_DETECTOR)
                break;
        }
        if (count > 0) {
            findings.push({
                id: detector.id,
                category: detector.category,
                severity: detector.severity,
                sample,
                count,
            });
            // 同类多次命中呈边际递减：首次全额，其后每次 +severity/4。
            risk += detector.severity + (count - 1) * (detector.severity / 4);
        }
    }
    risk = Math.min(MAX_RISK, Math.round(risk));
    const verdict = risk >= MALICIOUS_THRESHOLD ? 'malicious' : risk >= SUSPICIOUS_THRESHOLD ? 'suspicious' : 'clean';
    return { findings, risk, verdict };
}
/** 注入检测设置仓库（dlp-settings 表 'injection' 键）。 */
export class InjectionSettingsStore {
    table;
    constructor(domain) {
        this.table = domain.table('dlp-settings');
    }
    get() {
        return this.table.get('injection') ?? { enabled: true, strict: false };
    }
    async update(patch) {
        const next = { ...this.get(), ...patch };
        await this.table.put('injection', next);
        return next;
    }
}
