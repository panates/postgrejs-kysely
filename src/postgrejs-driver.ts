import {
  type AbortableOperationOptions,
  CompiledQuery,
  type DatabaseConnection,
  type Driver,
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

  async beginTransaction(
    connection: DatabaseConnection,
    settings: TransactionSettings,
  ): Promise<void> {
    const { isolationLevel, accessMode } = settings;
    if (!isolationLevel && !accessMode) {
      await assertPostgrejsConnection(connection).connection.startTransaction();
      return;
    }
    // PostgreJS only ever sends a bare BEGIN, so anything with settings on
    // it is spelled out here. Its bookkeeping still follows: `commit()`
    // and `rollback()` below decide what to send from the server's own
    // transaction status, not from a depth counter this bypasses.
    let sql = 'start transaction';
    if (isolationLevel) sql += ` isolation level ${isolationLevel}`;
    if (accessMode) sql += ` ${accessMode}`;
    await connection.executeQuery(CompiledQuery.raw(sql));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await assertPostgrejsConnection(connection).connection.commit();
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await assertPostgrejsConnection(connection).connection.rollback();
  }

  /**
   * The three savepoint methods go through PostgreJS's own primitives
   * rather than the `compileQuery` Kysely offers, which is why that
   * argument is left out of their signatures: PostgreJS tracks savepoints
   * per name, and SQL sent behind its back would desynchronise that
   * bookkeeping from the server.
   *
   * The trade-off is PostgreJS's stricter idea of a name: it accepts
   * `/^[a-zA-Z]\w+$/` and rejects the rest, where Kysely quotes whatever
   * it is given. A leading underscore, a dash, or a single-character name
   * therefore throws here and would not through `pg`.
   */
  async savepoint(
    connection: DatabaseConnection,
    savepointName: string,
  ): Promise<void> {
    await assertPostgrejsConnection(connection).connection.savepoint(
      savepointName,
    );
  }

  async rollbackToSavepoint(
    connection: DatabaseConnection,
    savepointName: string,
  ): Promise<void> {
    await assertPostgrejsConnection(connection).connection.rollbackToSavepoint(
      savepointName,
    );
  }

  async releaseSavepoint(
    connection: DatabaseConnection,
    savepointName: string,
  ): Promise<void> {
    await assertPostgrejsConnection(connection).connection.releaseSavepoint(
      savepointName,
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
