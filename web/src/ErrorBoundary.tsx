import { Component, type ReactNode } from "react";

interface ErrorBoundaryProps {
	children: ReactNode;
}

interface ErrorBoundaryState {
	error: Error | null;
}

/**
 * 应用级错误边界:组件树任一处运行时抛错(SSE reducer、cytoscape 图等)时
 * 显示中文错误页 + 「重新加载」按钮,而不是整页白屏。
 * 仅 class 组件可实现(getDerivedStateFromError),按 React 惯例包裹 App 根。
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
	state: ErrorBoundaryState = { error: null };

	static getDerivedStateFromError(error: Error): ErrorBoundaryState {
		return { error };
	}

	render() {
		if (this.state.error !== null) {
			return (
				<div style={{ padding: "48px 24px", maxWidth: 560, margin: "0 auto", lineHeight: 1.8 }}>
					<h1 style={{ fontSize: 20, marginBottom: 12 }}>出错了</h1>
					<p style={{ color: "var(--muted)" }}>
						界面发生运行时错误,应用已暂停渲染。错误信息:{String(this.state.error.message || this.state.error)}
					</p>
					<button
						type="button"
						style={{
							marginTop: 16,
							padding: "8px 20px",
							border: "1px solid var(--line)",
							borderRadius: 8,
							background: "var(--bg-elev)",
							color: "var(--ink)",
							cursor: "pointer",
						}}
						onClick={() => {
							this.setState({ error: null });
							location.reload();
						}}
					>
						重新加载
					</button>
				</div>
			);
		}
		return this.props.children;
	}
}
