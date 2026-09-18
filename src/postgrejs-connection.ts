import type { CompiledQuery, DatabaseConnection, QueryResult } from 'kysely';
import type { Connection, QueryOptions } from 'postgrejs';
import { MAX_FETCH_COUNT } from './constants.js';
import type { PostgrejsDialectConfig } from './postgrejs-dialect-config.js';

/**
 * The part of the dialect config a single connection reads - everything
 * about how a statement is executed, and nothing about where connections
 * come from.
 */
export type PostgrejsConnectionOptions = Pick<
  PostgrejsDialectConfig,
  'fetchCount' | 'prepare' | 'rollbackOnError' | 'typeMap'
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
 * One PostgreJS connection, as Kysely's `DatabaseConnection`.
 *
 * A new instance wraps each acquire: PostgreJS's pool builds a fresh
 * `Connection` facade over the same physical connection every time, so
 * there is nothing stable to cache these on.
 *
 * Neither method takes Kysely's `AbortableOperationOptions`, and that is
 * deliberate rather than an omission: Kysely races the query against the
 * signal itself, and what happens to the statement still running on the
 * server is chosen by the caller's `inflightQueryAbortStrategy`, through
 * the optional `cancelQuery`/`killSession` methods. Handing the signal
 * down to PostgreJS - which cancels the statement out of band - would
 * silently make every abort behave like `'cancel query'`, whatever the
 * caller asked for. Kysely's own `pg` dialect ignores the argument for
 * the same reason.
 */
export class PostgrejsConnection implements DatabaseConnection {
  protected readonly _connection: Connection;
  protected readonly _config: PostgrejsConnectionOptions;

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
      numAffectedRows: rowsAffected == null ? undefined : BigInt(rowsAffected),
    };
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
      // loop, or threw.
      await cursor.close();
    }
  }

  protected _queryOptions(compiledQuery: CompiledQuery): QueryOptions {
    const config = this._config;
    return {
      params: compiledQuery.parameters as any[],
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
