import type { Cleanup } from './types.js';

/**
 * Detects client-side navigation (History API, back/forward, route-style
 * hashes) and calls `onChange` when the route changed. A change of the query
 * string alone is not a new view; the path and a `#/route` fragment are.
 */
export function instrumentRoutes(onChange: () => void): Cleanup {
  let lastRoute = routeKey();
  const historyObject = window.history;
  const originalPushState = historyObject.pushState;
  const originalReplaceState = historyObject.replaceState;

  const notifyIfChanged = (): void => {
    const current = routeKey();
    if (current === lastRoute) return;
    lastRoute = current;
    onChange();
  };

  const wrappedPushState: History['pushState'] = function (
    this: History,
    data: unknown,
    unused: string,
    url?: string | URL | null,
  ): void {
    originalPushState.call(this, data, unused, url);
    notifyIfChanged();
  };
  const wrappedReplaceState: History['replaceState'] = function (
    this: History,
    data: unknown,
    unused: string,
    url?: string | URL | null,
  ): void {
    originalReplaceState.call(this, data, unused, url);
    notifyIfChanged();
  };

  historyObject.pushState = wrappedPushState;
  historyObject.replaceState = wrappedReplaceState;
  window.addEventListener('popstate', notifyIfChanged);
  window.addEventListener('hashchange', notifyIfChanged);

  return () => {
    window.removeEventListener('popstate', notifyIfChanged);
    window.removeEventListener('hashchange', notifyIfChanged);
    if (historyObject.pushState === wrappedPushState) {
      historyObject.pushState = originalPushState;
    }
    if (historyObject.replaceState === wrappedReplaceState) {
      historyObject.replaceState = originalReplaceState;
    }
  };
}

function routeKey(): string {
  const { pathname, hash } = window.location;
  const route = /^#!?\//.test(hash) ? (hash.split('?', 1)[0] ?? '') : '';
  return `${pathname}${route}`;
}
