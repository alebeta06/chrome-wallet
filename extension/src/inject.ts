/**
 * @file inject.ts
 * @description Runs in the page's own JavaScript world. Phase 0 stub.
 *
 * From Phase 5 on, this is where the EIP-1193 provider lives and where
 * `window.codecrypto` gets defined. Today it only plants a flag so the build
 * can be verified from the browser console.
 *
 * Built as a CLASSIC script (see vite.config.scripts.ts). It has no access to
 * any `chrome.*` API: its only channel out is window.postMessage.
 */

import { PROTOCOL, PROTOCOL_VERSION, PROVIDER_NAME } from "@/types/messages";

declare global {
  interface Window {
    /** Phase 0 build probe. Type `window.__ccInjectLoaded` in any page console. */
    __ccInjectLoaded?: boolean;
  }
}

window.__ccInjectLoaded = true;

console.log(
  `[${PROTOCOL}] ${PROVIDER_NAME} inject.js running in the page world — protocol v${PROTOCOL_VERSION}`,
);
