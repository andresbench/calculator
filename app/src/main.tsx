import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('no #root in index.html');

createRoot(container).render(
  <StrictMode>
    {/* The last net: App itself failing to draw. The screens have their own, under the header. */}
    <ErrorBoundary standalone>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
