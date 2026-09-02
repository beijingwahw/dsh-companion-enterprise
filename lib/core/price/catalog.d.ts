/**
 * 国产主流大模型官方价格内置目录（元/百万 tokens，快照日期 2026-08-14）。
 * 移植自 dsh-usage-ledger/src/catalog.ts。
 *
 * DeepSeek 部分由官方定价页实时抓取覆盖；其余厂商在此维护官方刊例价快照，
 * 用户可通过成本设置的 pricing 覆盖补充任意模型价格。
 *
 * 说明：部分厂商按输入长度/输出占比阶梯计价，这里收录最低档（常见短上下文）
 * 价格作为记账基准，报表中会注明"阶梯计价，按最低档"。
 */
import type { PriceTable } from './types.js';
/** 厂商展示信息。 */
export interface VendorInfo {
    /** 展示名称。 */
    label: string;
    /** 官方定价页（展示用）。 */
    pricingUrl: string;
    /** 实际抓取的数据源 URL；缺省同 pricingUrl。 */
    dataSource?: string;
    /**
     * 抓取方式：html=通用表格解析；ernie-cdn=百度 CDN page-data；kimi-rsc=Kimi RSC 子页；
     * zhipu-bundle=智谱 SPA JS 包内嵌价格+运营位接口；doubao-md=火山文档中心 Markdown 接口。
     */
    fetchKind?: 'html' | 'ernie-cdn' | 'kimi-rsc' | 'zhipu-bundle' | 'doubao-md';
    /** 是否阶梯计价（目录中为最低档价格）。 */
    tiered?: boolean;
}
/** 全部厂商 id（与 VENDORS 的键一一对应）。 */
export declare const VENDOR_IDS: readonly ['deepseek', 'zhipu', 'moonshot', 'qwen', 'doubao', 'minimax', 'ernie'];
/** 厂商 id 的精确类型：以字面量联合取代裸 string，未知厂商无法通过类型检查。 */
export type VendorId = (typeof VENDOR_IDS)[number];
/** 厂商元信息：键类型精确到 VendorId，"deepseek 必然存在"由类型系统背书。 */
export declare const VENDORS: Record<VendorId, VendorInfo>;
/**
 * 内置价格目录（官方刊例价快照，元/百万 tokens）。
 * inputCacheHit 为缓存命中输入价；未公布缓存价的按输入价约 20% 估算并标注。
 */
export declare const CATALOG_TABLE: PriceTable;
/** 识别模型所属厂商；未知返回 undefined。 */
export declare function vendorOf(model: string): string | undefined;
/**
 * 按任意字符串安全查找厂商元信息（未知 id 返回 undefined）。
 * hasOwn 收窄后断言到 VendorId 是合法的类型收窄（非危险断言）：
 * 调用方拿到的 undefined 即"未知厂商"信号，无需非空断言。
 */
export declare function vendorInfoOf(vendorId: string): VendorInfo | undefined;
/** 某厂商的全部模型 id 前缀（用于在定价页表格中识别模型单元格）。 */
export declare function prefixesOf(vendorId: string): string[];
