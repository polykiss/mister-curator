import type { CSSProperties, JSX } from 'react';
import { Toaster } from 'sonner';

import { AppErrorBoundary } from '@app/renderer/src/components/AppErrorBoundary';
import { BrowserScreen } from '@app/renderer/src/components/BrowserScreen';
import { ConnectionScreen } from '@app/renderer/src/components/ConnectionScreen';
import { ConnectionProvider, useConnection } from '@app/renderer/src/contexts/ConnectionContext';
import { CoresProvider } from '@app/renderer/src/contexts/CoresContext';
import { OperationStatusProvider } from '@app/renderer/src/contexts/OperationStatusContext';

function Routes(): JSX.Element {
  const { status, lostConnection } = useConnection();
  // Stay on the browser screen while a session was just lost — the
  // user can still browse cached cores in read-only mode and act on
  // the disconnect banner to either Reconnect or bail out.
  if (status === 'connected' || lostConnection) {
    return <BrowserScreen />;
  }
  return <ConnectionScreen />;
}

// Sonner exposes its surface via CSS custom properties — we map them
// onto the design tokens so toasts inherit the system. The `richColors`
// flag still drives per-status accents (success / error / warning),
// which Sonner pulls from its own internal palette; the base surface
// underneath stays consistent with the rest of the app.
const TOAST_TOKENS = {
  '--normal-bg': 'hsl(var(--bg-overlay))',
  '--normal-border': 'hsl(var(--border-default))',
  '--normal-text': 'hsl(var(--fg-primary))',
} as CSSProperties;

export function App(): JSX.Element {
  // OperationStatusProvider has to wrap ConnectionProvider + CoresProvider
  // so those contexts can call useOperationStatus() to publish their
  // long-running operation messages to the StatusBar.
  // AppErrorBoundary sits at the very top so the user always lands on
  // a recoverable screen if something thrown during render escapes
  // the contexts' own try/catches.
  return (
    <AppErrorBoundary>
      <OperationStatusProvider>
        <ConnectionProvider>
          <CoresProvider>
            <Routes />
            <Toaster
              position="bottom-right"
              theme="dark"
              richColors
              closeButton
              toastOptions={{ style: TOAST_TOKENS, className: 'font-sans' }}
            />
          </CoresProvider>
        </ConnectionProvider>
      </OperationStatusProvider>
    </AppErrorBoundary>
  );
}
