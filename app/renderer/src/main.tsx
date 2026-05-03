import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

// Global safety net for promise rejections that escape every other
// catch site. React error boundaries don't cover async rejections;
// without this, the only signal of an unhandled IPC failure is a
// silent dev-tools warning. Logging here makes leaks discoverable
// without changing user-visible behaviour.
window.addEventListener('unhandledrejection', (event) => {
  console.warn('Unhandled promise rejection:', event.reason);
});

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element #root not found');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
