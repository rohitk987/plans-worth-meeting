import { AlertTriangle, RotateCcw } from "lucide-react";
import { Component, ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="error-page">
          <section>
            <AlertTriangle size={42} aria-hidden="true" />
            <span className="eyebrow">Plans hit a snag</span>
            <h1>That didn’t go to plan.</h1>
            <p>Reload the page and your saved profile, matches, and chats will still be here.</p>
            {import.meta.env.DEV && this.state.error?.stack ? <details><summary>Development details</summary><pre>{this.state.error.stack}</pre></details> : null}
            <button onClick={() => window.location.reload()} className="button">
              <RotateCcw size={16} />
              Reload page
            </button>
          </section>
        </main>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
