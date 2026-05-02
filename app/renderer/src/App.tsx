import type { JSX } from 'react';
import { Toaster } from 'sonner';

import { BrowserScreen } from '@app/renderer/src/components/BrowserScreen';
import { ConnectionScreen } from '@app/renderer/src/components/ConnectionScreen';
import { ConnectionProvider, useConnection } from '@app/renderer/src/contexts/ConnectionContext';
import { CoresProvider } from '@app/renderer/src/contexts/CoresContext';

function Routes(): JSX.Element {
  const { status } = useConnection();
  if (status === 'connected') {
    return <BrowserScreen />;
  }
  return <ConnectionScreen />;
}

export function App(): JSX.Element {
  return (
    <ConnectionProvider>
      <CoresProvider>
        <Routes />
        <Toaster position="bottom-right" richColors closeButton />
      </CoresProvider>
    </ConnectionProvider>
  );
}
