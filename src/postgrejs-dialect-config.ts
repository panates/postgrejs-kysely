import type { AbortableOperationOptions, DatabaseConnection } from 'kysely';
import type { DataTypeMap, Pool } from 'postgrejs';

/**
 * Config for the PostgreJS dialect.
 */
export interface PostgrejsDialectConfig {
  /**
   * How many rows each statement may return before PostgreSQL suspends the
   * portal. Defaults to {@link MAX_FETCH_COUNT}, i.e. "however many there
   * are" - see that constant for why this is not left to PostgreJS's own
   * default. `streamQuery` ignores this and uses Kysely's `chunkSize`.
   */
  fetchCount?: number;

  /**
   * Whether each parameter's PostgreSQL type is left to the server to
   * resolve from where it appears in the query - what `pg` does, and what
   * Kysely's users therefore expect.
   *
   * Defaults to `true`. PostgreJS otherwise declares a type derived from
   * the JavaScript value, which makes a string a `varchar` and breaks
   * every context where PostgreSQL would have inferred something else: a
   * `json` column, a `coalesce` of mixed types, `||`, an overloaded
   * function. Only strings, numbers, booleans, bigints and nulls are
   * affected - dates, buffers, arrays and objects keep PostgreJS's typed,
   * binary encoding either way.
   */
  inferParameterTypes?: boolean;

  /**
   * Called once for each physical connection the pool opens, before it is
   * first handed to Kysely.
   *
   * PostgreJS's pool builds a fresh `Connection` facade on every acquire,
   * so "the same connection" is recognised by its backend process id
   * rather than by object identity. A pid is forgotten when the pool
   * destroys that connection, so the hook runs again for its replacement.
   */
  onCreateConnection?: (
    connection: DatabaseConnection,
    options?: AbortableOperationOptions,
  ) => Promise<void>;

  /**
   * Called every time a connection is acquired from the pool.
   */
  onReserveConnection?: (
    connection: DatabaseConnection,
    options?: AbortableOperationOptions,
  ) => Promise<void>;

  /**
   * A PostgreJS `Pool` instance, or a function returning one - the
   * function is called once, when the driver initialises.
   *
   * The driver never uses `pool.query()`: that is free to pick a different
   * connection per call, which would scatter a transaction across
   * connections. It acquires and releases explicitly instead.
   */
  pool: Pool | ((options?: AbortableOperationOptions) => Promise<Pool>);

  /**
   * Whether statements are cached as server-side prepared statements.
   * Leave unset to follow the connection's own `prepare` setting;
   * `false` is what PgBouncer in transaction pooling mode needs (before
   * 1.21), where a named statement does not survive to the next call.
   */
  prepare?: boolean;

  /**
   * Whether a failed statement inside a transaction leaves the rest of the
   * transaction usable.
   *
   * Defaults to `false`, which is PostgreSQL's own behaviour and the one
   * `pg` - and therefore every existing Kysely user - expects: the
   * transaction is aborted and nothing but a rollback is accepted after
   * it. PostgreJS defaults this to `true` instead, wrapping every
   * statement in a savepoint of its own; set it back to `true` here to opt
   * into that.
   */
  rollbackOnError?: boolean;

  /**
   * A custom `DataTypeMap`, to override how individual PostgreSQL types
   * are decoded. Defaults to PostgreJS's `GlobalTypeMap`.
   */
  typeMap?: DataTypeMap;
}
