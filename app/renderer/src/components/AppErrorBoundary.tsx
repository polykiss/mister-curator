import { AlertCircle, RotateCcw } from 'lucide-react';
import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

import { Button } from '@app/renderer/src/components/ui/button';

interface AppErrorBoundaryState {
  readonly error: Error | null;
}

interface AppErrorBoundaryProps {
  readonly children: ReactNode;
}

/**
 * Last-resort safety net — catches anything thrown synchronously
 * during a renderer-side render or lifecycle. Promise rejections that
 * escape `try/catch` in event handlers are NOT covered by React error
 * boundaries (that's a documented limitation), so the contexts also
 * have to keep catching their async work. This component just makes
 * sure a thrown error during render shows a useful screen rather than
 * a blank window.
 */
export class AppErrorBoundary extends Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  override state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface to the dev console so packaging-time logs capture it.
    // Production should hook this into a real telemetry sink later.
    console.error('AppErrorBoundary caught:', error, info);
  }

  private readonly handleReload = (): void => {
    window.location.reload();
  };

  override render(): ReactNode {
    if (this.state.error === null) {
      return this.props.children;
    }
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <div
          role="alert"
          className="max-w-md rounded-lg border border-destructive/40 bg-destructive/10 p-5 text-sm"
        >
          <div className="flex items-start gap-3">
            <AlertCircle
              className="mt-0.5 h-5 w-5 shrink-0 text-destructive"
              aria-hidden
            />
            <div className="min-w-0 flex-1 space-y-2">
              <h2 className="text-base font-semibold text-destructive">
                Something went wrong.
              </h2>
              <p className="text-muted-foreground">
                MiSTerCurator hit an unexpected error and couldn&apos;t finish
                rendering. Reloading the window usually fixes this.
              </p>
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer select-none">
                  Technical details
                </summary>
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-2">
                  {this.state.error.message}
                </pre>
              </details>
              <div className="pt-1">
                <Button onClick={this.handleReload} size="sm">
                  <RotateCcw />
                  Reload
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
