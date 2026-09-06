import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Top-level React error boundary. Catches render errors anywhere in the
 * subtree and shows a recoverable fallback instead of a blank screen.
 * The whole editor surface is large and canvas/WebGL-heavy; an unexpected
 * throw during render (e.g. a worker result shape change, a null canvas
 * ref) should never leave the user staring at a white page.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Uncaught render error:", error, info.componentStack);
  }

  private handleReset = (): void => {
    this.setState({ error: null });
  };

  private handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-muted p-6">
          <div className="max-w-md text-center">
            <AlertTriangle className="mx-auto mb-4 h-10 w-10 text-destructive" aria-hidden />
            <h1 className="mb-2 text-2xl font-bold">Something went wrong</h1>
            <p className="mb-6 text-muted-foreground">
              The editor hit an unexpected error. Your image is still in memory —
              reloading will start fresh.
            </p>
            <div className="flex justify-center gap-3">
              <button
                type="button"
                onClick={this.handleReset}
                className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-accent"
              >
                Try again
              </button>
              <button
                type="button"
                onClick={this.handleReload}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                Reload page
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
