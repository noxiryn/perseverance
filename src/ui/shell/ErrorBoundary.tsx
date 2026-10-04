/**
 * Isolates feature components (panels, options bars, status items, viewport) so one failing
 * module cannot take down the whole editor chrome.
 */
import { Component, type ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';

interface Props {
  /** Shown in the fallback ("Layers panel crashed"). */
  name: string;
  children: ReactNode;
  /** Compact single-line fallback (for bars). */
  inline?: boolean;
  /** Changing this resets the boundary (e.g. panel id). */
  resetKey?: unknown;
}

interface State {
  error: Error | null;
  key: unknown;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, key: undefined };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey !== state.key) return { key: props.resetKey, error: null };
    return null;
  }

  componentDidCatch(error: Error) {
    console.error(`[shell] ${this.props.name} crashed:`, error);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.inline) {
      return (
        <span className="shell-error-inline" title={error.message}>
          <TriangleAlert size={12} /> {this.props.name} failed to load
        </span>
      );
    }
    return (
      <div className="shell-error">
        <TriangleAlert size={18} />
        <div className="shell-error-title">{this.props.name} ran into a problem</div>
        <div className="shell-error-msg">{error.message}</div>
        <button className="ui-btn small" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
