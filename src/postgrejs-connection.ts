import type {
  CompiledQuery,
  DatabaseConnection,
  QueryId,
  QueryResult,
} from 'kysely';
import { BindParam, Connection, type QueryOptions } from 'postgrejs';
import { MAX_FETCH_COUNT } from './constants.js';
import type { PostgrejsDialectConfig } from './postgrejs-dialect-config.js';

/**
 * The part of the dialect config a single connection reads - everything
 * about how a statement is executed, and nothing about where connections
 * come from.
 */
export type PostgrejsConnectionOptions = Pick<
  PostgrejsDialectConfig,
  | 'fetchCount'
  | 'inferParameterTypes'
  | 'prepare'
  | 'rollbackOnError'
  | 'typeMap'
>;

/**
 * Commands whose row count answers "how many rows did this change?".
 *
 * MERGE is in the list because Kysely counts it, but PostgreJS only fills
 * `rowsAffected` for INSERT/UPDATE/DELETE, so a MERGE reports `undefined`
 * rather than a count. Nothing is invented here to cover that up - the
 * number simply does not reach us.
 */
const AFFECTED_ROW_COMMANDS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE']);

/**
 * Parameter type OID 0 - "I am not telling you, work it out from the
 * query". PostgreSQL then resolves the parameter from where it appears.
 */
const UNSPECIFIED_OID = 0;

/**
 * The JavaScript types whose PostgreSQL type is better left to the
 * server. Everything else - Date, Buffer, arrays, objects - keeps
 * PostgreJS's own type determination and its binary encoders, which are
 * both correct and faster, and where a value's text form is not something
 * PostgreSQL could parse anyway.
 */
const INFERRED_PARAM_TYPES = new Set(['string', 'number', 'boolean', 'bigint']);

/**
 * One PostgreJS connection, as Kysely's `DatabaseConnection`.
 *
 * A new instance wraps each acquire: PostgreJS's pool builds a fresh
 * `Connection` facade over the same physical connection every time, so
 * there is nothing stable to cache these on.
 *
 * Neither `executeQuery` nor `streamQuery` takes Kysely's
 * `AbortableOperationOptions`, and that is deliberate rather than an
 * omission: Kysely races the query against the signal itself, and what
 * happens to the statement still running on the server is the caller's
 * choice, made through `inflightQueryAbortStrategy` and carried out by
 * `cancelQuery`/`killSession` below. Handing the signal down to PostgreJS
 * - which cancels the statement out of band - would silently make every
 * abort behave like `'cancel query'`, whatever the caller asked for.
 * Kysely's own `pg` dialect ignores the argument for the same reason.
 *
 * `collectSessionInfo` is not implemented, also deliberately: it exists
 * so a dialect can go and find the session's own backend process id
 * before a query starts, and PostgreJS already knows it - skipping the
 * hook saves the round trip Kysely's `pg` dialect spends on
 * `pg_backend_pid()`.
 */
export class PostgrejsConnection implements DatabaseConnection {
  protected readonly _connection: Connection;
  protected readonly _config: PostgrejsConnectionOptions;
  /**
   * The query `executeQuery` is waiting on, if any. Both abort handlers
   * are no-ops without one: a cancel that arrives after its query
   * finished is harmless, but `killSession` would otherwise take down a
   * connection that has already gone back to doing someone else's work.
   */
  protected _inflightQueryId?: QueryId;

  constructor(connection: Connection, config: PostgrejsConnectionOptions) {
    this._connection = connection;
    this._config = config;
  }

  /**
   * The underlying PostgreJS connection - everything Kysely's interface
   * does not cover (COPY, LISTEN/NOTIFY, large objects, logical
   * replication) is reachable through it.
   */
  get connection(): Connection {
    return this._connection;
  }

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    this._inflightQueryId = compiledQuery.queryId;
    try {
      const result = await this._connection.query(
        compiledQuery.sql,
        this._queryOptions(compiledQuery),
      );
      const rowsAffected =
        result.command && AFFECTED_ROW_COMMANDS.has(result.command)
          ? result.rowsAffected
          : undefined;
      return {
        rows: (result.rows || []) as R[],
        numAffectedRows:
          rowsAffected == null ? undefined : BigInt(rowsAffected),
      };
    } catch (error) {
      // The stack of an error from a pooled connection stops at the
      // driver; this puts the call that asked for the query back on it.
      throw extendStackTrace(error, new Error());
    } finally {
      this._inflightQueryId = undefined;
    }
  }

  async *streamQuery<R>(
    compiledQuery: CompiledQuery,
    chunkSize: number,
  ): AsyncIterableIterator<QueryResult<R>> {
    if (!Number.isInteger(chunkSize) || chunkSize <= 0)
      throw new Error('chunkSize must be a positive integer');
    const result = await this._connection.query(compiledQuery.sql, {
      ...this._queryOptions(compiledQuery),
      // One server round trip per chunk rather than per row: the cursor
      // fetches `fetchCount` rows at a time, and `fetch()` hands out that
      // same number.
      cursor: true,
      fetchCount: chunkSize,
    });
    /* c8 ignore next - `cursor: true` always produces one */
    if (!result.cursor) throw new Error('Server did not return a cursor');
    const cursor = result.cursor;
    try {
      while (true) {
        const rows = await cursor.fetch(chunkSize);
        if (!rows.length) break;
        yield { rows: rows as R[] };
      }
    } finally {
      // Closes whether the consumer ran out of rows, broke out of the
      // loop, or threw. This is also how an aborted stream ends: Kysely
      // calls the iterator's `return()` rather than either handler below.
      await cursor.close();
    }
  }

  /**
   * Cancels the statement this connection is running, for Kysely's
   * `'cancel query'` abort strategy.
   *
   * The CancelRequest travels on a connection of its own, which the
   * protocol opens for exactly this - so unlike Kysely's `pg` dialect,
   * nothing here waits for a second pooled connection to fall idle, and
   * the `controlConnectionProvider` Kysely offers goes unused. The
   * cancelled statement rejects with PostgreSQL's `57014`, and the
   * connection stays usable.
   *
   * Cancelling is a request, not a guarantee: the statement may finish
   * first, and writes are often past the point of being cancellable.
   */
  async cancelQuery(): Promise<void> {
    if (!this._inflightQueryId) return;
    await this._connection.cancel();
  }

  /**
   * Terminates the backend this connection is running on, for Kysely's
   * `'kill session'` abort strategy - the query, its transaction and any
   * locks it holds go with it.
   *
   * `pg_terminate_backend` has to be called from another session, and
   * that session is opened for the occasion rather than borrowed from the
   * pool: killing is the strategy for when the query must stop at all
   * costs, and queueing behind a busy pool - possibly behind the very
   * connection being killed - would defeat it.
   */
  async killSession(): Promise<void> {
    const queryId = this._inflightQueryId;
    if (!queryId) return;
    const processId = this._connection.processID;
    /* c8 ignore next - a connection the pool handed out is connected */
    if (processId == null) return;
    const control = this._createControlConnection();
    await control.connect();
    try {
      // Opening that connection took a moment, and the query may have
      // finished in it. Killing the backend then would take down a
      // connection that is no longer doing what we wanted stopped.
      if (this._inflightQueryId !== queryId) return;
      await control.query('select pg_terminate_backend($1)', {
        params: [processId],
      });
    } finally {
      await control.close();
    }
  }

  /**
   * The session `killSession` runs `pg_terminate_backend` from. It is
   * built from the pooled connection's own configuration, so it reaches
   * the same server as the same user with no further wiring.
   */
  protected _createControlConnection(): Connection {
    return new Connection(this._connection.config);
  }

  /**
   * PostgreJS gives every parameter a type OID derived from its
   * JavaScript value, and a string becomes `varchar`. That is a
   * declaration, not a hint: `insert into t (json_column) values ($1)`
   * then fails with "column is of type json but expression is of type
   * character varying", and so do `coalesce($1, 1)`, `$1 || x`, and any
   * call to an overloaded function. `pg` sends type 0 - unspecified - and
   * lets PostgreSQL resolve each parameter from where it appears, which
   * is why none of that surfaces there.
   *
   * Wrapping a value in a `BindParam` of OID 0 asks PostgreJS for the
   * same thing: type 0 in Parse, and the value as text in Bind. Set
   * `inferParameterTypes: false` to go back to declaring types.
   */
  protected _params(parameters: readonly unknown[]): unknown[] {
    if (this._config.inferParameterTypes === false)
      return parameters as unknown[];
    const l = parameters.length;
    const params = new Array(l);
    let i: number;
    let value: unknown;
    for (i = 0; i < l; i++) {
      value = parameters[i];
      params[i] =
        value == null || INFERRED_PARAM_TYPES.has(typeof value)
          ? new BindParam(UNSPECIFIED_OID, value)
          : value;
    }
    return params;
  }

  protected _queryOptions(compiledQuery: CompiledQuery): QueryOptions {
    const config = this._config;
    return {
      params: this._params(compiledQuery.parameters),
      // Kysely reads rows as objects; PostgreJS hands out arrays of
      // values unless told otherwise.
      rowDecoder: 'object',
      fetchCount: config.fetchCount ?? MAX_FETCH_COUNT,
      // PostgreSQL's own behaviour: a failed statement aborts the
      // transaction. PostgreJS defaults to the opposite.
      rollbackOnError: config.rollbackOnError ?? false,
      prepare: config.prepare,
      typeMap: config.typeMap,
    };
  }
}

/**
 * Kysely's own `extendStackTrace`, which it does not export: an error
 * thrown from inside a pooled connection carries the driver's stack, not
 * the caller's, and this appends the one captured where the query was
 * issued.
 */
function extendStackTrace(error: unknown, stackError: Error): unknown {
  if (
    error !== null &&
    typeof error === 'object' &&
    typeof (error as { stack?: unknown }).stack === 'string' &&
    stackError.stack
  ) {
    const holder = error as { stack: string };
    // The first line is just "Error", which would read as a second error.
    holder.stack += '\n' + stackError.stack.split('\n').slice(1).join('\n');
  }
  return error;
}
