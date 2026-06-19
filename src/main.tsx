import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { loadWebapis } from './tv/tizen';
import { registerRemoteKeys } from './tv/keys';
import App from './App';
import './index.css';

// Boot order matters on Tizen: load the native Web Device API first (AVPlay
// lives there), then claim the extra remote keys, then mount React.
async function boot() {
  await loadWebapis();
  registerRemoteKeys();
  const root = document.getElementById('root');
  if (!root) throw new Error('#root missing');
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void boot();
