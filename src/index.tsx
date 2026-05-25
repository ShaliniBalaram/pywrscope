import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { installTauriBridge } from './tauri_bridge';

// Install the Tauri ↔ window.pywr bridge before React renders.
// All hooks and components use window.pywr.* as before — no other changes needed.
installTauriBridge();

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);
root.render(<App />);
