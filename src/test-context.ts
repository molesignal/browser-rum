/**
 * What tells the SDK that a test drives the page rather than a person: a synthetic check or a test
 * run sets `window.__MOLESIGNAL_TEST_CONTEXT__` before any script of the page runs. Such a session
 * is always recorded and says what drove it, and the server leaves it out of the figures of real
 * users. The page is told which session it became, for the check to link to it.
 */
export interface TestContext {
  type: 'synthetics' | 'ci_test';
  test_id?: string;
  result_id?: string;
  location_id?: string;
  test_execution_id?: string;
}

const CONTEXT_GLOBAL = '__MOLESIGNAL_TEST_CONTEXT__';
const SESSION_GLOBAL = '__MOLESIGNAL_RUM_SESSION__';
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

type Globals = Record<string, unknown>;

function identifier(value: unknown): string | undefined {
  return typeof value === 'string' && IDENTIFIER_PATTERN.test(value) ? value : undefined;
}

export function readTestContext(): TestContext | undefined {
  const context = (globalThis as unknown as Globals)[CONTEXT_GLOBAL] as Globals | undefined;
  if (!context || typeof context !== 'object') return undefined;
  if (context.type !== 'synthetics' && context.type !== 'ci_test') return undefined;
  return {
    type: context.type,
    test_id: identifier(context.test_id),
    result_id: identifier(context.result_id),
    location_id: identifier(context.location_id),
    test_execution_id: identifier(context.test_execution_id),
  };
}

/** Says which session a test drives, on the page it drives. */
export function publishTestSession(sessionId: string): void {
  (globalThis as unknown as Globals)[SESSION_GLOBAL] = sessionId;
}
