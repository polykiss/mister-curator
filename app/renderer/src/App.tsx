import type { JSX } from 'react';
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
            <Toaster position="bottom-right" richColors closeButton />
          </CoresProvider>
        </ConnectionProvider>
      </OperationStatusProvider>
    </AppErrorBoundary>
  );
}
