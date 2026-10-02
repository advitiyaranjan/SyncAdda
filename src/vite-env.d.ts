/// <reference types="vite/client" />

// Safari's prefixed fullscreen API (older iPads and Macs).
interface Document {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
}
interface HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void;
}
