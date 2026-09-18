import {
  type AbortableOperationOptions,
  CompiledQuery,
  createQueryId,
  type DatabaseConnection,
  type Driver,
  IdentifierNode,
  type QueryCompiler,
  RawNode,
  type TransactionSettings,
} from 'kysely';
import type { Pool } from 'postgrejs';
import { PostgrejsConnection } from './postgrejs-connection.js';
import type { PostgrejsDialectConfig } from './postgrejs-dialect-config.js';

/** What the pool's `destroy` event hands us, narrowed to what we read. */
interface DestroyedConnection {
  processID?: number;
}

export class PostgrejsDriver implements Driver {
  protected readonly _config: PostgrejsDialectConfig;
  /**
   * Backend process ids `onCreateConnection` has already run for. A pid
   * identifies a physical connection where object identity cannot: the
   * pool builds a new `Connection` facade on every acquire. Entries are
   * dropped when the pool destroys that connection, so its replacement is
   * initialised again.
   */
  protected readonly _initializedProcessIds = new Set<number>();
  protected _pool?: Pool;
  protected _onPoolDestroy?: (connection: DestroyedConnection) => void;

  constructor(config: PostgrejsDialectConfig) {
    this._config = Object.freeze({ ...config });
  }

  async init(options?: AbortableOperationOptions): Promise<void> {
    const { pool } = this._config;
    const resolved = typeof pool === 'function' ? await pool(options) : pool;
    this._onPoolDestroy = (connection: DestroyedConnection) => {
      if (connection?.processID != null)
        this._initializedProcessIds.delete(connection.processID);
    };
    resolved.on('destroy', this._onPoolDestroy);
    this._pool = resolved;
  }

  async acquireConnection(
    options?: AbortableOperationOptions,
  ): Promise<DatabaseConnection> {
    const connection = new PostgrejsConnection(
      await this._assertPool().acquire(),
      this._config,
    );
    const { onCreateConnection, onReserveConnection } = this._config;
    if (onCreateConnection) {
      const pid = connection.connection.processID;
      if (pid == null || !this._initializedProcessIds.has(pid)) {
        if (pid != null) this._initializedProcessIds.add(pid);
        await onCreateConnection(connection, options);
      }
    }
    if (onReserveConnection) await onReserveConnection(connection, options);
    return connection;
  }

  /**
   * Every transaction and savepoint command goes through the connection's
   * own `executeQuery` rather than PostgreJS's same-named primitives -
   * `startTransaction()`, `commit()`, `savepoint(name)` and the rest.
   *
   * That seam is where Kysely wraps logging: `RuntimeDriver` patches
   * `executeQuery` on each connection it hands out, so a BEGIN sent any
   * other way never reaches the `log` callback, `db.on('query')`, or
   * anything else built on it - it simply does not exist as far as Kysely
   * is concerned. Kysely's own dialect test suite asserts the full list
   * of statements a transaction runs, and running the primitives instead
   * fails around two dozen of those cases.
   *
   * Nothing is lost by going through SQL. PostgreJS reads `inTransaction`
   * from the server's own transaction status rather than from the depth
   * counter its primitives keep, and recognises BEGIN/COMMIT/SAVEPOINT in
   * a statement, so its bookkeeping stays in step either way. Savepoint
   * names also stop being restricted to PostgreJS's `/^[a-zA-Z]\w+$/`:
   * Kysely compiles the name as a quoted identifier, as `pg` does.
   */
  async beginTransaction(
    connection: DatabaseConnection,
    settings: TransactionSettings,
  ): Promise<void> {
    const { isolationLevel, accessMode } = settings;
    let sql = 'begin';
    if (isolationLevel || accessMode) {
      sql = 'start transaction';
      if (isolationLevel) sql += ` isolation level ${isolationLevel}`;
      if (accessMode) sql += ` ${accessMode}`;
    }
    await connection.executeQuery(CompiledQuery.raw(sql));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('commit'));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('rollback'));
  }

  async savepoint(
    connection: DatabaseConnection,
    savepointName: string,
    compileQuery: QueryCompiler['compileQuery'],
  ): Promise<void> {
    await connection.executeQuery(
      compileSavepointCommand('savepoint', savepointName, compileQuery),
    );
  }

  async rollbackToSavepoint(
    connection: DatabaseConnection,
    savepointName: string,
    compileQuery: QueryCompiler['compileQuery'],
  ): Promise<void> {
    await connection.executeQuery(
      compileSavepointCommand('rollback to', savepointName, compileQuery),
    );
  }

  async releaseSavepoint(
    connection: DatabaseConnection,
    savepointName: string,
    compileQuery: QueryCompiler['compileQuery'],
  ): Promise<void> {
    await connection.executeQuery(
      compileSavepointCommand('release', savepointName, compileQuery),
    );
  }

  async releaseConnection(connection: DatabaseConnection): Promise<void> {
    await this._pool?.release(assertPostgrejsConnection(connection).connection);
  }

  async destroy(): Promise<void> {
    const pool = this._pool;
    if (!pool) return;
    this._pool = undefined;
    if (this._onPoolDestroy)
      pool.removeListener('destroy', this._onPoolDestroy);
    this._initializedProcessIds.clear();
    await pool.close();
  }

  protected _assertPool(): Pool {
    if (!this._pool)
      throw new Error('Driver is not initialized. Did you call init()?');
    return this._pool;
  }
}

/**
 * A savepoint command as Kysely's own dialects build it: the name goes
 * through the dialect's compiler as an identifier, so it is quoted rather
 * than pasted into the SQL. Kysely keeps its `parseSavepointCommand`
 * internal, so the two nodes it makes are spelled out here.
 */
function compileSavepointCommand(
  command: string,
  savepointName: string,
  compileQuery: QueryCompiler['compileQuery'],
): CompiledQuery {
  return compileQuery(
    RawNode.createWithChildren([
      RawNode.createWithSql(`${command} `),
      IdentifierNode.create(savepointName),
    ]),
    createQueryId(),
  );
}

/**
 * Kysely hands a driver back the connection its own `acquireConnection`
 * returned, so this only ever fails for a connection from somewhere else.
 */
function assertPostgrejsConnection(
  connection: DatabaseConnection,
): PostgrejsConnection {
  if (!(connection instanceof PostgrejsConnection))
    throw new TypeError('Connection was not created by PostgrejsDriver');
  return connection;
}
