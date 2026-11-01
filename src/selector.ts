import type { RumActionBody } from './events.js';
import type { PrivacyLevel } from './types.js';
import { truncate } from './utils.js';

const MAX_PATH_CHARS = 2_048;

/**
 * A CSS-like selector for an element. With the `mask` privacy level it only
 * describes the structure (tag and position among siblings of the same tag):
 * ids, test ids, classes and custom names can carry personal data.
 */
export function elementSelector(
  element: Element,
  actionNameAttribute: string,
  privacyLevel: PrivacyLevel,
): string {
  const tag = element.tagName.toLowerCase();
  if (privacyLevel === 'mask') return structuralSelector(element, tag);

  const explicit = element.getAttribute(actionNameAttribute)?.trim();
  if (explicit) return `[${actionNameAttribute}="${escapeAttributeValue(explicit)}"]`;

  const id = element.id.trim();
  if (id && isStableIdentifier(id)) return `${tag}#${escapeSelectorValue(id)}`;

  const testId =
    element.getAttribute('data-testid')?.trim() ||
    element.getAttribute('data-test')?.trim();
  if (testId) return `${tag}[data-testid="${escapeAttributeValue(testId)}"]`;

  const classes = Array.from(element.classList)
    .filter(isStableIdentifier)
    .slice(0, 2)
    .map((name) => `.${escapeSelectorValue(name)}`)
    .join('');
  if (classes) return `${tag}${classes}`;

  return structuralSelector(element, tag);
}

/**
 * Where an element stands in the page, by tags and places among siblings of the same tag, from the
 * body down: enough to find it again in a recording of the page, and nothing a person wrote. A page
 * nested too deep to say it in this many characters has none.
 */
export function elementPath(element: Element): string | undefined {
  const steps: string[] = [];
  let current: Element | null = element;
  while (current && current !== document.documentElement) {
    steps.unshift(structuralSelector(current, current.tagName.toLowerCase()));
    current = current.parentElement;
  }
  const path = steps.join('>');
  return path.length <= MAX_PATH_CHARS ? path : undefined;
}

/** The label of an action target, and where it came from. */
export function actionTargetName(
  element: HTMLElement,
  selector: string,
  privacyLevel: PrivacyLevel,
  actionNameAttribute: string,
): { name: string; source: NonNullable<RumActionBody['name_source']> } {
  if (privacyLevel !== 'mask') {
    const explicit = element.getAttribute(actionNameAttribute)?.trim();
    if (explicit) return { name: truncate(explicit, 160), source: 'custom_attribute' };
    const standard =
      element.getAttribute('aria-label')?.trim() || element.getAttribute('title')?.trim();
    if (standard) return { name: truncate(standard, 160), source: 'standard_attribute' };
    const text = element.innerText?.trim().replace(/\s+/g, ' ');
    if (text) return { name: truncate(text, 160), source: 'text_content' };
    return { name: `Click ${selector}`, source: 'blank' };
  }
  return { name: `Click ${selector}`, source: 'mask_placeholder' };
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

/** Inside a quoted attribute value only the quote and the backslash need escaping. */
function escapeAttributeValue(value: string): string {
  return value.replace(/["\\]/g, '\\$&').replace(/\n/g, '\\a ');
}

function escapeSelectorValue(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, '\\$&');
}
