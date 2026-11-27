import fs from 'node:fs';
import path from 'node:path';

export { renderPushHtml, renderSetupHtml } from './client/pages.mjs';

const clientDir = path.join(import.meta.dirname, 'client');
const readClientFile = (name) => fs.readFileSync(path.join(clientDir, name), 'utf8');

export const MANIFEST_JSON = JSON.stringify(
  {
    name: 'Antigravity',
    short_name: 'Antigravity',
    description: 'Antigravity Local Relay',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#0b0b0f',
    theme_color: '#0b0b0f',
    icons: [
      {
        src: '/relay-icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/relay-icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: '/relay-icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/relay-icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  },
  null,
  2,
);

export const ICON_192 = fs.readFileSync(path.join(import.meta.dirname, 'icon-192.png'));
export const ICON_512 = fs.readFileSync(path.join(import.meta.dirname, 'icon-512.png'));
export const MOBILE_CSS = readClientFile('mobile.css');
export const SW_JS = readClientFile('sw.js');

const mobileJsParts = ['idb-cache.js', 'ws-transport.js', 'ws-control.js', 'bridges.js', 'file-sheet.js', 'ui-runtime.js'].map(readClientFile);
export const MOBILE_JS = `(() => {
  if (window.__agyRelayMobileInit) return;
  window.__agyRelayMobileInit = true;

${mobileJsParts.join('\n')}
})();`;
