/**
 * Entry of the browser bundle (`dist/molesignal-rum.js`), which defines the
 * global `MoleSignalRum`.
 *
 * The bundle can be loaded asynchronously. The page first defines a stub,
 *
 *   window.MoleSignalRum = { q: [], onReady: function (callback) { this.q.push(callback); } };
 *
 * and calls `MoleSignalRum.onReady(...)` right away. When the script arrives it
 * replaces the stub with the real API and runs the queued callbacks in order.
 */
import { createRumApi } from './api.js';

interface Stub {
  q?: unknown;
}

const target = globalThis as typeof globalThis & { MoleSignalRum?: Stub };
const stub = target.MoleSignalRum;
const api = createRumApi();
target.MoleSignalRum = api as unknown as Stub;

if (stub && Array.isArray(stub.q)) {
  for (const callback of stub.q.splice(0)) {
    if (typeof callback === 'function') api.onReady(callback as () => void);
  }
}
