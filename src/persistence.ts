import type { NormalizedRumConfiguration } from './config.js';
import { fnv1a, reportInternalError } from './utils.js';

export interface PersistedQueueEntry {
  id: string;
  queueKey: string;
  kind: string;
  createdAt: number;
  /** The tab that queued the row; it is the one that sends it. */
  owner?: string;
}

/** A tab renews its lease this often, and others take over its rows once the lease is this old. */
export const LEASE_RENEW_MS = 30_000;
export const LEASE_TTL_MS = 3 * 60_000;

const DATABASE_NAME = 'molesignal-rum';
const STORE_NAME = 'queue';
/**
 * Version 2 holds contract events. The rows of version 1 were bound for the
 * retired session/action/error endpoints and are dropped on upgrade.
 */
const DATABASE_VERSION = 2;

/** Small IndexedDB wrapper used by the transport's at-least-once queue. */
export class IndexedDbQueueStorage<T extends PersistedQueueEntry> {
  readonly queueKey: string;
  private readonly enabled: boolean;
  private databasePromise?: Promise<IDBDatabase | undefined>;

  constructor(private readonly config: NormalizedRumConfiguration) {
    this.enabled =
      config.enablePersistentQueue && typeof indexedDB !== 'undefined';
    this.queueKey = `v2:${fnv1a(`${config.applicationId}|${config.site}`)}`;
  }

  /**
   * Takes over the rows nobody is sending: the earlier page loads of this tab,
   * and the rows of tabs whose lease ran out. Tabs that are alive keep theirs,
   * so a second tab does not send the first one's events again. Reading the
   * rows, checking the leases and claiming the rows is one transaction, which
   * IndexedDB serializes against the other tabs'.
   */
  async claim(owner: string, now = Date.now()): Promise<T[]> {
    const database = await this.database();
    if (!database) return [];
    try {
      return await new Promise<T[]>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const claimed: T[] = [];
        // Own lease first, so that no other tab takes the rows this tab is about to claim.
        store.put(this.leaseRow(owner, now));
        const request = store.index('queueKey').getAll(IDBKeyRange.only(this.queueKey));
        request.onsuccess = () => {
          const rows = (request.result ?? []) as Array<PersistedQueueEntry & { owner?: string }>;
          const alive = new Set<string>();
          for (const row of rows) {
            if (row.kind !== 'lease' || row.owner === undefined) continue;
            if (row.owner !== owner && now - row.createdAt < LEASE_TTL_MS) alive.add(row.owner);
          }
          for (const row of rows) {
            if (row.kind === 'lease') {
              if (row.owner !== owner && now - row.createdAt >= LEASE_TTL_MS) store.delete(row.id);
              continue;
            }
            if (row.owner === owner || row.owner === undefined || !alive.has(row.owner)) {
              const mine = { ...row, owner } as T;
              if (row.owner !== owner) store.put(mine);
              claimed.push(mine);
            }
          }
        };
        request.onerror = () => reject(request.error ?? new Error('IndexedDB read failed'));
        transaction.oncomplete = () => resolve(claimed);
        transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB claim failed'));
        transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB claim aborted'));
      });
    } catch (error) {
      this.report(error, 'RUM persistent queue restore failed');
      return [];
    }
  }

  /** Tells the other tabs that this one is alive and still sending its rows. */
  async renewLease(owner: string): Promise<void> {
    await this.mutate((store) => store.put(this.leaseRow(owner, Date.now())));
  }

  /** Lets the other tabs take over this tab's unsent rows right away. */
  async releaseLease(owner: string): Promise<void> {
    await this.remove([this.leaseId(owner)]);
  }

  private leaseId(owner: string): string {
    return `lease:${this.queueKey}:${owner}`;
  }

  private leaseRow(owner: string, now: number): PersistedQueueEntry {
    return { id: this.leaseId(owner), queueKey: this.queueKey, kind: 'lease', createdAt: now, owner };
  }

  async put(entry: T): Promise<void> {
    await this.mutate((store) => store.put(entry));
  }

  async remove(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.mutate((store) => {
      for (const id of ids) store.delete(id);
    });
  }

  async replace(ids: string[], entry: T): Promise<void> {
    await this.mutate((store) => {
      store.put(entry);
      for (const id of ids) store.delete(id);
    });
  }

  async clear(): Promise<void> {
    const database = await this.database();
    if (!database) return;
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const index = store.index('queueKey');
        const request = index.openKeyCursor(IDBKeyRange.only(this.queueKey));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          store.delete(cursor.primaryKey);
          cursor.continue();
        };
        request.onerror = () => reject(request.error ?? new Error('IndexedDB clear failed'));
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB clear failed'));
        transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB clear aborted'));
      });
    } catch (error) {
      this.report(error, 'RUM persistent queue clear failed');
    }
  }

  private async mutate(operation: (store: IDBObjectStore) => void): Promise<void> {
    const database = await this.database();
    if (!database) return;
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readwrite');
        operation(transaction.objectStore(STORE_NAME));
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB write failed'));
        transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB write aborted'));
      });
    } catch (error) {
      this.report(error, 'RUM persistent queue write failed');
      throw error;
    }
  }

  private database(): Promise<IDBDatabase | undefined> {
    if (!this.enabled) return Promise.resolve(undefined);
    this.databasePromise ??= new Promise((resolve) => {
      let settled = false;
      try {
        const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
        request.onupgradeneeded = (event) => {
          const database = request.result;
          if (event.oldVersion > 0 && event.oldVersion < DATABASE_VERSION) {
            if (database.objectStoreNames.contains(STORE_NAME)) {
              database.deleteObjectStore(STORE_NAME);
            }
          }
          if (!database.objectStoreNames.contains(STORE_NAME)) {
            const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' });
            store.createIndex('queueKey', 'queueKey', { unique: false });
          }
        };
        request.onsuccess = () => {
          if (settled) {
            request.result.close();
            return;
          }
          settled = true;
          // Let a newer SDK version upgrade the database from another tab.
          request.result.onversionchange = () => {
            request.result.close();
            this.databasePromise = undefined;
          };
          resolve(request.result);
        };
        request.onerror = () => {
          if (settled) return;
          settled = true;
          this.report(request.error, 'RUM persistent queue unavailable');
          resolve(undefined);
        };
        request.onblocked = () => {
          if (settled) return;
          settled = true;
          this.report(new Error('IndexedDB upgrade is blocked'), 'RUM persistent queue unavailable');
          resolve(undefined);
        };
      } catch (error) {
        settled = true;
        this.report(error, 'RUM persistent queue unavailable');
        resolve(undefined);
      }
    });
    return this.databasePromise;
  }

  private report(error: unknown, prefix: string): void {
    reportInternalError(this.config.onError, error, prefix);
  }
}
