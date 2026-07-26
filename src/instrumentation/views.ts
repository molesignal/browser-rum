import type { Cleanup, InstrumentationHooks } from './types.js';

export function instrumentViews(hooks: InstrumentationHooks): Cleanup {
  let lastUrl = window.location.href;
  const historyObject = window.history;
  const originalPushState = historyObject.pushState;
  const originalReplaceState = historyObject.replaceState;

  const notifyIfChanged = (): void => {
    const current = window.location.href;
    if (current === lastUrl) return;
    lastUrl = current;
    hooks.markChange();
    hooks.startView();
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
