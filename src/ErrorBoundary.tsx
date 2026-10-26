import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** 出错区域的名称,便于定位(如「计算器」「主界面」)。 */
  label?: string
}

interface State {
  error: Error | null
  info: string
}

/**
 * 全局错误边界:子树渲染崩溃时,显示可读的错误信息而不是整页白屏。
 * 同时把错误打印到控制台,并尝试写入 localStorage 便于事后排查。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: '' }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const detail = info.componentStack ?? ''
    this.setState({ info: detail })
    console.error(`[${this.props.label ?? 'App'}] 渲染崩溃:`, error, detail)
    try {
      const log = JSON.stringify({
        time: new Date().toISOString(),
        label: this.props.label ?? 'App',
        message: error.message,
        stack: (error.stack ?? '').slice(0, 2000),
      })
      localStorage.setItem('todobar.crash.last', log)
    } catch {
      // 忽略存储失败。
    }
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div
        style={{
          padding: 24,
          fontSize: 13,
          lineHeight: 1.6,
          color: '#b91c1c',
          background: '#fff7ed',
          borderRadius: 8,
          wordBreak: 'break-all',
        }}
      >
        <strong>「{this.props.label ?? '应用'}」出现异常,已停止渲染:</strong>
        <div style={{ marginTop: 6 }}>{error.message}</div>
        {this.state.info && (
          <pre style={{ marginTop: 8, fontSize: 11, color: '#92400e', maxHeight: 180, overflow: 'auto' }}>
            {this.state.info.slice(0, 1200)}
          </pre>
        )}
        <button
          type="button"
          onClick={() => this.setState({ error: null, info: '' })}
          style={{ marginTop: 10, padding: '4px 12px', cursor: 'pointer' }}
        >
          重试
        </button>
      </div>
    )
  }
}
