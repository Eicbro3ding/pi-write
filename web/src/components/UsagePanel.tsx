/**
 * 会话用量卡(2026-09-23):把 vendor 原生的 `AgentSession.getSessionStats()` 摊开给人看
 * —— 累计 token(输入/输出/缓存读写)、成本、按 provider/model 拆分。
 *
 * 与输入条上那个上下文圆环的**口径差别**(别混):圆环是"现在上下文多大"
 * (`getContextUsage()` → 当前 leaf 链的估算),这里是"这一章一共花了多少"
 * (累计整个会话文件,含被压缩掉的历史)。所以这里的数字只涨不跌。
 *
 * 金额单位跟随供应商(DeepSeek 按美元),不做汇率/单位换算 —— 宁可给原值也不猜。
 */
import type { SessionUsageStatsDto } from "../types.ts";
import { Lu } from "./Lu.tsx";

/** 千分位;非有限数给 "—"(脏数据不渲染成 NaN)。导出供单测(项目惯例:纯函数抽出来测)。 */
export function formatCount(n: number): string {
	return Number.isFinite(n) ? n.toLocaleString("zh-CN") : "—";
}

/** 成本:0 或负数显示「—」(有些供应商不上报 cost);很小时多给几位,否则都是 0.00。 */
export function formatCost(v: number): string {
	if (!Number.isFinite(v) || v <= 0) return "—";
	return v < 1 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
}

export function UsagePanel({
	stats,
	loading,
	err,
	onClose,
}: {
	stats: SessionUsageStatsDto | null;
	loading: boolean;
	err: string | null;
	onClose: () => void;
}) {
	return (
		<div className="usage-pop" role="dialog" aria-label="本会话用量">
			<div className="usage-head">
				<span className="usage-title">本会话用量</span>
				<span className="usage-note">累计 · 含已压缩的历史</span>
				<button type="button" className="usage-close" aria-label="关闭用量" title="关闭" onClick={onClose}>
					<Lu icon="x" size={13} />
				</button>
			</div>

			{loading ? (
				<div className="usage-muted">统计中…</div>
			) : err ? (
				<div className="usage-err">{err}</div>
			) : !stats ? (
				<div className="usage-muted">这一章还没有会话记录</div>
			) : (
				<>
					<div className="usage-rows">
						<div className="usage-row">
							<span className="usage-k">消息</span>
							<span className="usage-v">
								{formatCount(stats.totalMessages)}
								<span className="usage-sub">(你 {formatCount(stats.userMessages)} / AI {formatCount(stats.assistantMessages)})</span>
							</span>
						</div>
						<div className="usage-row">
							<span className="usage-k">工具调用</span>
							<span className="usage-v">{formatCount(stats.toolCalls)} 次</span>
						</div>
						<div className="usage-row">
							<span className="usage-k">Token 合计</span>
							<span className="usage-v">{formatCount(stats.tokens.total)}</span>
						</div>
						<div className="usage-row">
							<span className="usage-k">输入 / 输出</span>
							<span className="usage-v mono">
								{formatCount(stats.tokens.input)} / {formatCount(stats.tokens.output)}
							</span>
						</div>
						<div className="usage-row">
							<span className="usage-k">缓存读 / 写</span>
							<span className="usage-v mono">
								{formatCount(stats.tokens.cacheRead)} / {formatCount(stats.tokens.cacheWrite)}
							</span>
						</div>
						<div className="usage-row">
							<span className="usage-k">成本</span>
							<span className="usage-v">
								{formatCost(stats.cost)}
								{/* 有 token 却算不出钱 = 该模型在目录里价格全是 0(例如 deepseek-flash)。
								    说清楚原因,否则用户以为这个功能坏了。 */}
								{stats.cost <= 0 && stats.tokens.total > 0 && <span className="usage-sub">该模型未配价格</span>}
							</span>
						</div>
					</div>

					{stats.breakdown.length > 0 && (
						<div className="usage-break">
							<div className="usage-sub-title">按模型拆分</div>
							{stats.breakdown.map((b) => (
								<div className="usage-brow" key={b.key}>
									<span className="usage-bkey" title={b.key}>
										{b.key}
									</span>
									<span className="usage-bval mono">
										{formatCount(b.tokens)} · {formatCost(b.cost)}
									</span>
								</div>
							))}
						</div>
					)}
				</>
			)}
		</div>
	);
}
