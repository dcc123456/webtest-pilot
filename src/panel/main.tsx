/**
 * Side-panel entry point.
 *
 * No `StrictMode`. It double-invokes effects in development, and this panel's
 * effects send real messages to the service worker — a doubled `getState` is
 * harmless, but a doubled `getArtifact` per thumbnail is wasted transfer, and the
 * duplicated `chrome.runtime.onMessage` registration makes an event stream look
 * like it is arriving twice. The bugs StrictMode is meant to surface are cheaper
 * to catch here by reading the effects than by debugging phantom double-sends.
 *
 * @module panel/main
 */

import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

const container = document.getElementById('root')
if (!container) {
  // The panel HTML is ours, so this can only mean the document failed to load.
  // Failing loudly beats a blank panel with no explanation.
  throw new Error('侧边栏根节点 #root 不存在，页面可能没有正确加载。')
}

createRoot(container).render(<App />)
