import { EventEmitter } from 'node:events';
import type { Connection, Pool, QueryOptions, QueryResult } from 'postgrejs';

/**
 * Stand-ins for PostgreJS's `Connection`/`Pool`, so the driver's own call
 * sequence can be asserted exactly - which options it passes, in which
 * order, and how many times - without a live server deciding any of it.
 */

export interface RecordedCall {
  method: string;
  args: any[];
}

export class FakeCursor {
  closed = false;
  readonly fetched: number[] = [];
  protected _batches: any[][];

  constructor(batches: any[][]) {
    this._batches = batches.map(batch => batch.slice());
  }

  async fetch(nRows: number): Promise<any[]> {
    this.fetched.push(nRows);
    return this._batches.shift() || [];
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export class FakeConnection {
  readonly calls: RecordedCall[] = [];
  processID?: number;
  /** What `query()` answers - or throws, when it is an Error. */
  queryResult:
    | QueryResult
    | Error
    | ((sql: string, options?: QueryOptions) => QueryResult | Error) = {
    command: 'SELECT',
    rows: [],
  };

  constructor(processID?: number) {
    this.processID = processID;
  }

  get queries(): { sql: string; options?: QueryOptions }[] {
    return this.calls
      .filter(call => call.method === 'query')
      .map(call => ({ sql: call.args[0], options: call.args[1] }));
  }

  async query(sql: string, options?: QueryOptions): Promise<QueryResult> {
    this.calls.push({ method: 'query', args: [sql, options] });
    const result =
      typeof this.queryResult === 'function'
        ? this.queryResult(sql, options)
        : this.queryResult;
    if (result instanceof Error) throw result;
    return result;
  }

  async startTransaction(): Promise<void> {
    this.calls.push({ method: 'startTransaction', args: [] });
  }

  async commit(): Promise<void> {
    this.calls.push({ method: 'commit', args: [] });
  }

  async rollback(): Promise<void> {
    this.calls.push({ method: 'rollback', args: [] });
  }

  async savepoint(name: string): Promise<void> {
    this.calls.push({ method: 'savepoint', args: [name] });
  }

  async rollbackToSavepoint(name: string): Promise<void> {
    this.calls.push({ method: 'rollbackToSavepoint', args: [name] });
  }

  async releaseSavepoint(name: string): Promise<void> {
    this.calls.push({ method: 'releaseSavepoint', args: [name] });
  }

  asConnection(): Connection {
    return this as unknown as Connection;
  }
}

export class FakePool extends EventEmitter {
  readonly acquired: FakeConnection[] = [];
  readonly released: FakeConnection[] = [];
  /** Backend pids handed to the next connections, in order. */
  readonly processIdSequence: number[] = [];
  closed = 0;
  protected _nextProcessId = 1000;

  async acquire(): Promise<Connection> {
    const connection = new FakeConnection(
      this.processIdSequence.length
        ? this.processIdSequence.shift()
        : this._nextProcessId++,
    );
    this.acquired.push(connection);
    return connection.asConnection();
  }

  async release(connection: Connection): Promise<void> {
    this.released.push(connection as unknown as FakeConnection);
  }

  async close(): Promise<void> {
    this.closed++;
  }

  asPool(): Pool {
    return this as unknown as Pool;
  }
}
