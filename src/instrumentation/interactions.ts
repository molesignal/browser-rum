import type { PrivacyLevel } from '../types.js';
import { truncate } from '../utils.js';
import type { Cleanup, InstrumentationHooks } from './types.js';

interface ClickSample {
  time: number;
  x: number;
  y: number;
  selector: string;
}

export function instrumentInteractions(
  hooks: InstrumentationHooks,
  options: {
    trackFrustrations: boolean;
    privacyLevel: PrivacyLevel;
    actionNameAttribute: string;
  },
): Cleanup {
  const clickSamples: ClickSample[] = [];
  const deadClickTimers = new Set<ReturnType<typeof globalThis.setTimeout>>();
  let mutationObserver: MutationObserver | undefined;

  const startMutationWatch = (): void => {
    if (
      mutationObserver ||
      typeof MutationObserver === 'undefined' ||
      !document.documentElement
    ) {
      return;
    }
    mutationObserver = new MutationObserver(() => hooks.markChange());
    mutationObserver.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  };

  const stopMutationWatchIfIdle = (): void => {
    if (deadClickTimers.size > 0) return;
    mutationObserver?.disconnect();
    mutationObserver = undefined;
  };

  const onClick = (event: MouseEvent): void => {
    if (event.button !== 0 || !(event.target instanceof Element)) return;
    const element = closestInteractiveElement(event.target, options.actionNameAttribute);
    if (!element) return;
    hooks.markActivity();

    const selector = elementSelector(
      element,
      options.actionNameAttribute,
      options.privacyLevel,
    );
    const name = interactionName(
      element,
      selector,
      options.privacyLevel,
      options.actionNameAttribute,
    );
    const context = {
      selector,
      x: Math.round(event.clientX),
      y: Math.round(event.clientY),
      button: event.button,
      tag: element.tagName.toLowerCase(),
    };
    hooks.recordAction({
      type: 'click',
      name,
      context,
    });

    if (!options.trackFrustrations || !event.isTrusted) return;
    const now = Date.now();
    clickSamples.push({
      time: now,
      x: event.clientX,
      y: event.clientY,
      selector,
    });
    while ((clickSamples[0]?.time ?? now) < now - 1_000) clickSamples.shift();
    const nearby = clickSamples.filter(
      (sample) =>
        sample.selector === selector &&
        distance(sample.x, sample.y, event.clientX, event.clientY) <= 50,
    );
    if (nearby.length >= 3) {
      hooks.recordAction({
        type: 'rage_click',
        name: `Repeated click on ${selector}`,
        context: { ...context, click_count: nearby.length, window_ms: 1_000 },
      });
      clickSamples.length = 0;
    }

    if (!canBeDeadClick(element)) return;
    startMutationWatch();
    const changeId = hooks.getChangeId();
    const timer = globalThis.setTimeout(() => {
      deadClickTimers.delete(timer);
      if (
        hooks.getChangeId() === changeId &&
        element.isConnected &&
        !isDisabled(element)
      ) {
        hooks.recordAction({
          type: 'dead_click',
          name: `No response after clicking ${selector}`,
          context: { ...context, wait_ms: 1_000 },
        });
      }
      stopMutationWatchIfIdle();
    }, 1_000);
    deadClickTimers.add(timer);
  };

  const onSubmit = (event: SubmitEvent): void => {
    if (!(event.target instanceof HTMLFormElement)) return;
    hooks.markActivity();
    const selector = elementSelector(
      event.target,
      options.actionNameAttribute,
      options.privacyLevel,
    );
    hooks.recordAction({
      type: 'submit',
      name: `Submit ${selector}`,
      context: { selector },
    });
  };

  document.addEventListener('click', onClick, true);
  document.addEventListener('submit', onSubmit, true);

  return () => {
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('submit', onSubmit, true);
    mutationObserver?.disconnect();
    for (const timer of deadClickTimers) globalThis.clearTimeout(timer);
    deadClickTimers.clear();
  };
}

function closestInteractiveElement(
  element: Element,
  actionNameAttribute: string,
): HTMLElement | undefined {
  let current: Element | null = element;
  while (current) {
    if (
      current instanceof HTMLElement &&
      current.hasAttribute(actionNameAttribute)
    ) {
      return current;
    }
    current = current.parentElement;
  }
  const candidate = element.closest(
    'a,button,input,select,textarea,label,summary,[role="button"],[role="link"],[tabindex]',
  );
  return candidate instanceof HTMLElement ? candidate : undefined;
}

function canBeDeadClick(element: HTMLElement): boolean {
  if (
    element instanceof HTMLAnchorElement ||
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLLabelElement ||
    element.isContentEditable
  ) {
    return false;
  }
  return (
    element instanceof HTMLButtonElement ||
    element.getAttribute('role') === 'button' ||
    element.hasAttribute('tabindex')
  );
}

function isDisabled(element: HTMLElement): boolean {
  return (
    element.getAttribute('aria-disabled') === 'true' ||
    ('disabled' in element && Boolean((element as HTMLButtonElement).disabled))
  );
}

function interactionName(
  element: HTMLElement,
  selector: string,
  privacyLevel: PrivacyLevel,
  actionNameAttribute: string,
): string {
  const explicit = element.getAttribute(actionNameAttribute)?.trim();
  if (privacyLevel === 'allow') {
    if (explicit) return truncate(explicit, 160);
    const label =
      element.getAttribute('aria-label')?.trim() ||
      element.getAttribute('title')?.trim() ||
      element.innerText?.trim().replace(/\s+/g, ' ');
    if (label) return truncate(label, 160);
  }
  return `Click ${selector}`;
}

function elementSelector(
  element: Element,
  actionNameAttribute: string,
  privacyLevel: PrivacyLevel,
): string {
  const tag = element.tagName.toLowerCase();
  if (privacyLevel === 'mask') return structuralSelector(element, tag);

  const explicit = element.getAttribute(actionNameAttribute)?.trim();
  if (explicit) return `[${actionNameAttribute}="${escapeSelectorValue(explicit)}"]`;

  const id = element.id.trim();
  if (id && isStableIdentifier(id)) return `${tag}#${escapeSelectorValue(id)}`;

  const testId =
    element.getAttribute('data-testid')?.trim() ||
    element.getAttribute('data-test')?.trim();
  if (testId) return `${tag}[data-testid="${escapeSelectorValue(testId)}"]`;

  const classes = Array.from(element.classList)
    .filter(isStableIdentifier)
    .slice(0, 2)
    .map((name) => `.${escapeSelectorValue(name)}`)
    .join('');
  if (classes) return `${tag}${classes}`;

  return structuralSelector(element, tag);
}

function structuralSelector(element: Element, tag: string): string {
  const parent = element.parentElement;
  if (!parent) return tag;
  const siblings = Array.from(parent.children).filter(
    (child) => child.tagName === element.tagName,
  );
  const index = siblings.indexOf(element);
  return index >= 0 && siblings.length > 1 ? `${tag}:nth-of-type(${index + 1})` : tag;
}

function isStableIdentifier(value: string): boolean {
  if (value.length === 0 || value.length > 80) return false;
  if (/^\d+$/.test(value)) return false;
  if (/[a-f\d]{12,}/i.test(value)) return false;
  return /^[\w-]+$/.test(value);
}

function escapeSelectorValue(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, '\\$&');
}

function distance(x1: number, y1: number, x2: number, y2: number): number {
  return Math.hypot(x1 - x2, y1 - y2);
}
