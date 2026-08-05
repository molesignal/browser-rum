import type { NormalizedRumConfiguration } from './config.js';
import { fnv1a, reportInternalError } from './utils.js';

export interface PersistedQueueEntry {
  id: string;
  queueKey: string;
  kind: string;
  createdAt: number;
}

const DATABASE_NAME = 'molesignal-rum';
const STORE_NAME = 'queue';
const DATABASE_VERSION = 1;

/** Small IndexedDB wrapper used by the transport's at-least-once queue. */
export class IndexedDbQueueStorage<T extends PersistedQueueEntry> {
  readonly queueKey: string;
  private readonly enabled: boolean;
  private databasePromise?: Promise<IDBDatabase | undefined>;

  constructor(private readonly config: NormalizedRumConfiguration) {
    this.enabled =
      config.enablePersistentQueue && typeof indexedDB !== 'undefined';
    this.queueKey = `v1:${fnv1a(`${config.applicationId}|${config.site}`)}`;
  }

  async load(): Promise<T[]> {
    const database = await this.database();
    if (!database) return [];
    try {
      return await new Promise<T[]>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readonly');
        const index = transaction.objectStore(STORE_NAME).index('queueKey');
        const request = index.getAll(IDBKeyRange.only(this.queueKey));
        request.onsuccess = () => resolve((request.result ?? []) as T[]);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB read failed'));
      });
    } catch (error) {
      this.report(error, 'RUM persistent queue restore failed');
      return [];
    }
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
        request.onupgradeneeded = () => {
          const database = request.result;
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
