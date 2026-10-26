import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);

/** Where the event contract lives: `MOLESIGNAL_CONTRACTS`, else the sibling server checkout. */
export function contractDirectory() {
  return resolve(
    repositoryRoot,
    process.env.MOLESIGNAL_CONTRACTS ?? '../molesignal/contracts/rum/events',
  );
}

let cached;

/**
 * Loads `v1.schema.json` with ajv (draft 2020-12). When the contract cannot be
 * found the result says why, so that tests can skip with an explanation.
 */
export function loadContract() {
  if (cached) return cached;
  const directory = contractDirectory();
  const schemaPath = join(directory, 'v1.schema.json');
  if (!existsSync(schemaPath)) {
    cached = {
      available: false,
      reason:
        `event contract not found at ${directory} ` +
        '(set MOLESIGNAL_CONTRACTS to the contracts/rum/events directory of the MoleSignal server); ' +
        'contract validation skipped',
    };
    return cached;
  }
  const Ajv2020 = require('ajv/dist/2020').default;
  const ajv = new Ajv2020({ allErrors: true });
  const validate = ajv.compile(JSON.parse(readFileSync(schemaPath, 'utf8')));
  cached = {
    available: true,
    directory,
    /** Error messages for one event; empty when it is valid. */
    check(event) {
      if (validate(event)) return [];
      return (validate.errors ?? []).map(
        (error) => `${error.instancePath || '/'} ${error.message}`,
      );
    },
    fixtures(kind) {
      const root = join(directory, 'fixtures', kind);
      return readdirSync(root)
        .filter((name) => name.endsWith('.json'))
        .sort()
        .map((name) => ({
          name,
          document: JSON.parse(readFileSync(join(root, name), 'utf8')),
        }));
    },
    manifest() {
      return JSON.parse(readFileSync(join(directory, 'fixtures', 'manifest.json'), 'utf8'));
    },
  };
  return cached;
}

/** A reason for `test(..., { skip })`: false when the contract is available. */
export function contractSkipReason() {
  const contract = loadContract();
  return contract.available ? false : contract.reason;
}

/**
 * Checks every event against the contract and returns the violations as
 * readable strings (empty when the contract is not available or all is well).
 */
export function contractViolations(events) {
  const contract = loadContract();
  if (!contract.available) return [];
  const violations = [];
  for (const [index, event] of events.entries()) {
    const errors = contract.check(event);
    if (errors.length > 0) {
      violations.push(
        `event #${index} (${event?.type ?? 'no type'}): ${errors.join('; ')}\n${JSON.stringify(event)}`,
      );
    }
  }
  return violations;
}

/** Every leaf of a JSON value as `path: type`, for comparing shapes. */
export function shapeOf(value, prefix = '', paths = new Map()) {
  if (Array.isArray(value)) {
    paths.set(prefix, 'array');
    if (value.length > 0) shapeOf(value[0], `${prefix}[]`, paths);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      shapeOf(entry, prefix ? `${prefix}.${key}` : key, paths);
    }
  } else {
    paths.set(prefix, value === null ? 'null' : typeof value);
  }
  return paths;
}

/**
 * Compares an SDK event with the fixture that shows the shape of the same kind
 * of event. Where both have a field they must agree on its JSON type; every
 * field of the fixture must be present unless `ignored` says the SDK cannot
 * be expected to produce it. Returns the problems found.
 */
export function shapeProblems(fixture, event, ignored = () => false) {
  const problems = [];
  const actual = shapeOf(event);
  for (const [path, type] of shapeOf(fixture)) {
    const found = actual.get(path);
    if (found !== undefined) {
      if (found !== type) {
        problems.push(`${fixture.type} ${path}: the fixture has ${type}, the SDK ${found}`);
      }
    } else if (!ignored(path)) {
      problems.push(`${fixture.type} ${path} is in the fixture but the SDK did not emit it`);
    }
  }
  return problems;
}

/** The fixtures that describe events from a browser, one event each. */
export function browserFixtures() {
  const contract = loadContract();
  if (!contract.available) return [];
  return contract
    .fixtures('valid')
    .flatMap((fixture) => (Array.isArray(fixture.document) ? fixture.document : [fixture.document]))
    .filter((event) => event.source === 'browser');
}

/**
 * `session.start` is optional in the schema, but the server expects it: it tells
 * a session that just began from one it lost track of. The SDK sends it on
 * every event, so the test suites hold it to that.
 */
export function sessionStartViolations(events) {
  return events
    .filter((event) => !Number.isInteger(event?.session?.start))
    .map((event) => `${event?.type} event without session.start: ${JSON.stringify(event?.session)}`);
}
