/**
 * The SDK in a React application: `@molesignal/browser-rum/react`.
 *
 * `reactPlugin()` makes the routes of a router the views of the SDK, named by their patterns
 * (`/orders/:id`, not `/orders/42`), so that a page's numbers do not spread over its ids.
 * `RumErrorBoundary` reports what a tree of components throws.
 */
import { Component, createElement, type ErrorInfo, type ReactNode } from 'react';

import type { RumClient, RumInitConfiguration, RumPlugin } from './types.js';

let started: RumClient | undefined;

export interface ReactPluginOptions {
  /** Views come from the router: the SDK does not start them when the address changes. Defaults to true. */
  router?: boolean;
}

export function reactPlugin(options: ReactPluginOptions = {}): RumPlugin {
  return {
    name: 'react',
    onInit(configuration: RumInitConfiguration) {
      if (options.router ?? true) configuration.trackViewsManually = true;
    },
    onStart({ client }) {
      started = client;
    },
  };
}

interface RouteMatch {
  route: { path?: string };
}

interface ReactRouterLike {
  state: { location: { pathname: string }; matches: RouteMatch[] };
  subscribe(listener: (state: { location: { pathname: string }; matches: RouteMatch[] }) => void): () => void;
}

/** The pattern of the routes that matched, as React Router has them. */
export function routePattern(matches: readonly RouteMatch[], pathname: string): string {
  let pattern = '';
  for (const { route } of matches) {
    const path = route.path;
    if (!path) continue;
    pattern = path.startsWith('/') ? path : `${pattern.replace(/\/$/, '')}/${path}`;
  }
  return pattern.includes('*') || !pattern ? pathname : pattern;
}

/**
 * Starts a view for each route of a React Router data router (`createBrowserRouter`). Returns what
 * stops it.
 */
export function trackReactRouter(router: ReactRouterLike): () => void {
  let last: string | undefined;
  const follow = (state: ReactRouterLike['state']): void => {
    if (state.location.pathname === last) return;
    last = state.location.pathname;
    started?.startView({ name: routePattern(state.matches, state.location.pathname) });
  };
  follow(router.state);
  return router.subscribe(follow);
}

interface TanStackRouterLike {
  state: { location: { pathname: string }; matches: Array<{ routeId: string }> };
  subscribe(event: 'onResolved', listener: () => void): () => void;
}

/** Starts a view for each route of a TanStack router. Returns what stops it. */
export function trackTanStackRouter(router: TanStackRouterLike): () => void {
  let last: string | undefined;
  const follow = (): void => {
    const { location, matches } = router.state;
    if (location.pathname === last) return;
    last = location.pathname;
    const route = matches[matches.length - 1]?.routeId;
    started?.startView({ name: route && route !== '__root__' ? route : location.pathname });
  };
  follow();
  return router.subscribe('onResolved', follow);
}

/** Reports an error a tree of components threw, with the stack of the components it went through. */
export function addReactError(error: unknown, info?: ErrorInfo): void {
  started?.addError(error, info?.componentStack ? { component_stack: info.componentStack } : {});
}

interface BoundaryProps {
  /** What is shown in place of a tree that threw. */
  fallback?: ReactNode;
  children?: ReactNode;
}

export class RumErrorBoundary extends Component<BoundaryProps, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    addReactError(error, info);
  }

  override render(): ReactNode {
    return this.state.failed
      ? createElement('div', { 'data-molesignal-error-boundary': '' }, this.props.fallback ?? null)
      : this.props.children;
  }
}
