import { RotateCcw } from 'lucide-react';
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
 *
 * Visual shape follows SYSTEM.md §5 empty-state pattern: display
 * heading, body-lg description, one primary CTA, vertically centered
 * in the viewport.
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
      <div
        role="alert"
        className="flex min-h-screen flex-col items-center justify-center gap-6 bg-canvas px-8 text-center"
      >
        <div className="flex max-w-md flex-col items-center gap-3">
          <h1 className="text-display text-fg">Something went wrong.</h1>
          <p className="text-body-lg text-fg-muted">
            MiSTerCurator hit an unexpected error and couldn&apos;t finish
            rendering. Reloading the window usually fixes this.
          </p>
        </div>
        <Button variant="primary" size="lg" onClick={this.handleReload}>
          <RotateCcw strokeWidth={1.5} />
          Reload window
        </Button>
        <details className="max-w-md text-left text-body-sm text-fg-muted">
          <summary className="cursor-pointer select-none text-fg-body">
            Technical details
          </summary>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-default bg-surface p-3 font-mono text-body-sm text-fg-body">
            {this.state.error.message}
          </pre>
        </details>
      </div>
    );
  }
}
