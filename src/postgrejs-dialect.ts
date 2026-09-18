import {
  type DatabaseIntrospector,
  type Dialect,
  type DialectAdapter,
  type Driver,
  type Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryCompiler,
} from 'kysely';
import type { PostgrejsDialectConfig } from './postgrejs-dialect-config.js';
import { PostgrejsDriver } from './postgrejs-driver.js';

/**
 * A Kysely dialect that runs on PostgreJS.
 *
 * ```ts
 * import { Kysely } from 'kysely';
 * import { Pool } from 'postgrejs';
 * import { PostgrejsDialect } from 'kysely-postgrejs';
 *
 * const db = new Kysely<Database>({
 *   dialect: new PostgrejsDialect({
 *     pool: new Pool('postgres://localhost:5432/mydb'),
 *   }),
 * });
 * ```
 *
 * Only the driver is PostgreJS-specific: the SQL PostgreSQL speaks is the
 * same either way, so the adapter, introspector and compiler are Kysely's
 * own.
 */
export class PostgrejsDialect implements Dialect {
  protected readonly _config: PostgrejsDialectConfig;

  constructor(config: PostgrejsDialectConfig) {
    this._config = config;
  }

  createAdapter(): DialectAdapter {
    return new PostgresAdapter();
  }

  createDriver(): Driver {
    return new PostgrejsDriver(this._config);
  }

  createIntrospector(db: Kysely<any>): DatabaseIntrospector {
    return new PostgresIntrospector(db);
  }

  createQueryCompiler(): QueryCompiler {
    return new PostgresQueryCompiler();
  }
}
