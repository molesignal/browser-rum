/**
 * The action in which events happen. A click opens a record at the moment of
 * the click and closes it when the page settles; resources, errors and long
 * tasks that *started* inside that window belong to it, however late they are
 * reported.
 */
export interface ActionRecord {
  id: string;
  startRel: number;
  endRel?: number;
  counts: { error: number; resource: number; long_task: number };
}

/** How long a closed action can still claim events that arrive late. */
const RETENTION_MS = 60_000;

export class ActionHistory {
  private records: ActionRecord[] = [];

  open(id: string, startRel: number): ActionRecord {
    const record: ActionRecord = {
      id,
      startRel,
      counts: { error: 0, resource: 0, long_task: 0 },
    };
    this.records.push(record);
    return record;
  }

  close(record: ActionRecord, endRel: number): void {
    record.endRel = Math.max(endRel, record.startRel);
  }

  /** The action active at `rel`, preferring the most recent one. */
  find(rel: number): ActionRecord | undefined {
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      const record = this.records[index];
      if (!record || record.startRel > rel) continue;
      if (record.endRel === undefined || rel <= record.endRel) return record;
    }
    return undefined;
  }

  /** The action that is still open at `rel`, for `getInternalContext()`. */
  current(): ActionRecord | undefined {
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      const record = this.records[index];
      if (record && record.endRel === undefined) return record;
    }
    return undefined;
  }

  prune(now: number): void {
    this.records = this.records.filter(
      (record) => record.endRel === undefined || now - record.endRel < RETENTION_MS,
    );
  }
}
