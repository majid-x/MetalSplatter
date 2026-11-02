import { Component, type ErrorInfo, type ReactNode } from 'react'

type Props = {
  children: ReactNode
  label?: string
}

type State = {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(this.props.label ?? 'UI error', error, info)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="pane-state">
          <h2>Something went wrong</h2>
          <p>{this.state.error.message}</p>
          <button
            type="button"
            className="pill-button compact"
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
