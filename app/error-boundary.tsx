import { Component, type ErrorInfo, type ReactNode } from "react";
import { BrandMark } from "./brand-mark";

export type ErrorBoundaryProps = {
  children?: ReactNode;
  fallback?: (error: Error, reset: () => void) => ReactNode;
};

type ErrorBoundaryState = {
  hasError: boolean;
  error: Error | null;
};

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = {
    hasError: false,
    error: null,
  };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error("[ErrorBoundary] 捕获到未处理的渲染异常：", error, errorInfo);
  }

  reset = (): void => {
    this.setState({ hasError: false, error: null });
  };

  private handleReload = (): void => {
    window.location.reload();
  };

  private handleHome = (): void => {
    window.location.href = "/app";
  };

  override render(): ReactNode {
    if (this.state.hasError && this.state.error) {
      if (this.props.fallback) {
        return this.props.fallback(this.state.error, this.reset);
      }

      return (
        <main className="app-error-shell" role="alert">
          <div className="app-error-card">
            <div className="app-error-header">
              <BrandMark size="default" />
              <h1>页面遇到意外错误</h1>
            </div>
            <p className="app-error-message">
              应用界面在运行时遇到了未预期的异常。未保存的文字已尝试在本地草稿中暂存保护。
            </p>
            {this.state.error.message && (
              <div className="app-error-details">
                <code>{this.state.error.message}</code>
              </div>
            )}
            <div className="app-error-actions">
              <button type="button" className="secondary-button" onClick={this.handleHome}>
                返回主页
              </button>
              <button type="button" className="primary-button" onClick={this.handleReload}>
                刷新重试
              </button>
            </div>
          </div>
        </main>
      );
    }

    return this.props.children;
  }
}

export function EditorErrorFallback({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="editor-error-pane" role="alert">
      <div className="editor-error-card">
        <h3>笔记编辑器遇到异常</h3>
        <p>当前笔记的局部内容可能触发了解析或渲染异常，其余笔记与侧边栏功能正常运行。</p>
        {error.message && (
          <div className="app-error-details">
            <code>{error.message}</code>
          </div>
        )}
        <div className="app-error-actions">
          <button type="button" className="primary-button" onClick={reset}>
            重新尝试加载
          </button>
        </div>
      </div>
    </div>
  );
}
