import { expect } from 'expect';
import { type Generated, Kysely, sql } from 'kysely';
import { DataTypeOIDs, Pool } from 'postgrejs';
import { PostgrejsDialect } from '../../src/postgrejs-dialect.js';

interface TestDatabase {
  kysely_postgrejs_test: {
    id: Generated<number>;
    name: string;
    amount: number | null;
  };
}

/**
 * The dialect against a real server and a real Kysely - the unit tests
 * above prove what the driver sends, these prove what comes back.
 */
describe('PostgrejsDialect (live)', () => {
  let db: Kysely<TestDatabase>;

  before(async () => {
    db = new Kysely<TestDatabase>({
      dialect: new PostgrejsDialect({ pool: new Pool({ max: 4 }) }),
    });
    await sql`drop table if exists kysely_postgrejs_test`.execute(db);
    await sql`create table kysely_postgrejs_test (
      id serial primary key,
      name varchar(64) not null unique,
      amount int
    )`.execute(db);
  });

  after(async () => {
    if (!db) return;
    await sql`drop table if exists kysely_postgrejs_test`.execute(db);
    await db.destroy();
  });

  beforeEach(async () => {
    await sql`truncate kysely_postgrejs_test restart identity`.execute(db);
  });

  it('should return rows as objects', async () => {
    await db
      .insertInto('kysely_postgrejs_test')
      .values({ name: 'a', amount: 1 })
      .execute();
    const rows = await db
      .selectFrom('kysely_postgrejs_test')
      .select(['id', 'name', 'amount'])
      .execute();
    expect(rows).toStrictEqual([{ id: 1, name: 'a', amount: 1 }]);
  });

  it('should return every row of a large result', async () => {
    // Guards the explicit fetchCount: a result that stopped short would
    // reach the caller as a complete one, since Kysely's QueryResult has
    // nowhere to carry PostgreJS's `suspended`.
    const result = await sql<{ i: number }>`
      select i from generate_series(1, 1000) i`.execute(db);
    expect(result.rows.length).toStrictEqual(1000);
    expect(result.rows[999].i).toStrictEqual(1000);
  });

  it('should count inserted, updated and deleted rows', async () => {
    const inserted = await db
      .insertInto('kysely_postgrejs_test')
      .values([
        { name: 'a', amount: 1 },
        { name: 'b', amount: 2 },
      ])
      .executeTakeFirst();
    expect(inserted.numInsertedOrUpdatedRows).toStrictEqual(BigInt(2));

    const updated = await db
      .updateTable('kysely_postgrejs_test')
      .set({ amount: 5 })
      .where('amount', '>', 0)
      .executeTakeFirst();
    expect(updated.numUpdatedRows).toStrictEqual(BigInt(2));

    const deleted = await db
      .deleteFrom('kysely_postgrejs_test')
      .where('name', '=', 'a')
      .executeTakeFirst();
    expect(deleted.numDeletedRows).toStrictEqual(BigInt(1));
  });

  it('should support returning', async () => {
    const row = await db
      .insertInto('kysely_postgrejs_test')
      .values({ name: 'a', amount: 1 })
      .returning(['id', 'name'])
      .executeTakeFirstOrThrow();
    expect(row).toStrictEqual({ id: 1, name: 'a' });
  });

  it('should commit a transaction', async () => {
    await db.transaction().execute(async trx => {
      await trx
        .insertInto('kysely_postgrejs_test')
        .values({ name: 'a', amount: 1 })
        .execute();
    });
    const rows = await db
      .selectFrom('kysely_postgrejs_test')
      .selectAll()
      .execute();
    expect(rows.length).toStrictEqual(1);
  });

  it('should roll a transaction back', async () => {
    const boom = new Error('rollback please');
    await expect(
      db.transaction().execute(async trx => {
        await trx
          .insertInto('kysely_postgrejs_test')
          .values({ name: 'a', amount: 1 })
          .execute();
        throw boom;
      }),
    ).rejects.toThrow(boom);
    const rows = await db
      .selectFrom('kysely_postgrejs_test')
      .selectAll()
      .execute();
    expect(rows).toStrictEqual([]);
  });

  it("should honour a transaction's isolation level and access mode", async () => {
    await db
      .transaction()
      .setIsolationLevel('serializable')
      .execute(async trx => {
        const result = await sql<{
          transaction_isolation: string;
        }>`show transaction_isolation`.execute(trx);
        expect(result.rows[0].transaction_isolation).toStrictEqual(
          'serializable',
        );
      });

    await expect(
      db
        .transaction()
        .setAccessMode('read only')
        .execute(async trx => {
          await trx
            .insertInto('kysely_postgrejs_test')
            .values({ name: 'a', amount: 1 })
            .execute();
        }),
    ).rejects.toThrow(/read-only transaction/);
  });

  it('should abort the transaction when a statement fails', async () => {
    // PostgreJS would keep the transaction usable by wrapping every
    // statement in a savepoint; the dialect turns that off by default so
    // a failure behaves the way PostgreSQL - and pg - behave.
    const trx = await db.startTransaction().execute();
    try {
      await trx
        .insertInto('kysely_postgrejs_test')
        .values({ name: 'a', amount: 1 })
        .execute();
      await expect(
        trx
          .insertInto('kysely_postgrejs_test')
          .values({ name: 'a', amount: 2 })
          .execute(),
      ).rejects.toMatchObject({ code: '23505' });
      await expect(
        trx.selectFrom('kysely_postgrejs_test').selectAll().execute(),
      ).rejects.toThrow(/current transaction is aborted/);
    } finally {
      await trx.rollback().execute();
    }
  });

  it('should support savepoints', async () => {
    const trx = await db.startTransaction().execute();
    try {
      await trx
        .insertInto('kysely_postgrejs_test')
        .values({ name: 'a', amount: 1 })
        .execute();
      const afterA = await trx.savepoint('afterA').execute();
      await afterA
        .insertInto('kysely_postgrejs_test')
        .values({ name: 'b', amount: 2 })
        .execute();
      await afterA.rollbackToSavepoint('afterA').execute();
      await afterA.releaseSavepoint('afterA').execute();
      await trx.commit().execute();
    } catch (e) {
      await trx.rollback().execute();
      throw e;
    }
    const rows = await db
      .selectFrom('kysely_postgrejs_test')
      .select('name')
      .execute();
    expect(rows).toStrictEqual([{ name: 'a' }]);
  });

  it('should stream a result in chunks', async () => {
    await db
      .insertInto('kysely_postgrejs_test')
      .values(
        Array.from({ length: 5 }, (_, i) => ({
          name: 'row' + i,
          amount: i,
        })),
      )
      .execute();
    const names: string[] = [];
    const stream = db
      .selectFrom('kysely_postgrejs_test')
      .select('name')
      .orderBy('id')
      .stream(2);
    for await (const row of stream) {
      names.push(row.name);
    }
    expect(names).toStrictEqual(['row0', 'row1', 'row2', 'row3', 'row4']);
  });

  it('should stop streaming when the consumer breaks out', async () => {
    await db
      .insertInto('kysely_postgrejs_test')
      .values(
        Array.from({ length: 10 }, (_, i) => ({
          name: 'row' + i,
          amount: i,
        })),
      )
      .execute();
    const names: string[] = [];
    for await (const row of db
      .selectFrom('kysely_postgrejs_test')
      .select('name')
      .orderBy('id')
      .stream(2)) {
      names.push(row.name);
      if (names.length === 3) break;
    }
    expect(names).toStrictEqual(['row0', 'row1', 'row2']);
    // The connection the cursor held must be usable again right away.
    const rows = await db
      .selectFrom('kysely_postgrejs_test')
      .selectAll()
      .execute();
    expect(rows.length).toStrictEqual(10);
  });

  it('should pass a PostgreSQL error through with its code', async () => {
    await expect(
      db
        .selectFrom('no_such_table' as any)
        .selectAll()
        .execute(),
    ).rejects.toMatchObject({ code: '42P01' });
  });

  it('should introspect the database', async () => {
    const tables = await db.introspection.getTables();
    const table = tables.find(t => t.name === 'kysely_postgrejs_test');
    expect(table).toBeDefined();
    expect(table!.columns.map(c => c.name).sort()).toStrictEqual([
      'amount',
      'id',
      'name',
    ]);
  });
  describe('aborting an in-flight query', () => {
    /** Backends sitting in a pg_sleep(), other than the one asking. */
    async function sleepingBackends(): Promise<number[]> {
      const result = await sql<{ pid: number }>`
        select pid from pg_stat_activity
        where query like 'select pg_sleep%' and pid <> pg_backend_pid()`.execute(
        db,
      );
      return result.rows.map(row => row.pid);
    }

    async function backendExists(pid: number): Promise<boolean> {
      const result = await sql`
        select 1 from pg_stat_activity where pid = ${pid}`.execute(db);
      return result.rows.length > 0;
    }

    /** Polls until `check` holds - the server acts on its own schedule. */
    async function waitUntil(
      check: () => Promise<boolean>,
      what: string,
      timeoutMs = 10000,
    ): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error(`Timed out waiting for ${what}`);
    }

    /** Starts a query that will not finish on its own. */
    async function startSleepingQuery(
      signal: AbortSignal,
      inflightQueryAbortStrategy: 'cancel query' | 'kill session',
    ): Promise<{ promise: Promise<unknown>; pid: number }> {
      const promise = sql`select pg_sleep(10)`
        .execute(db, { signal, inflightQueryAbortStrategy })
        .catch(error => error);
      await waitUntil(
        async () => (await sleepingBackends()).length === 1,
        'the query to reach the server',
      );
      const [pid] = await sleepingBackends();
      return { promise, pid };
    }

    afterEach(async () => {
      // A test that failed halfway would otherwise leave a backend
      // sleeping for the next one to trip over.
      for (const pid of await sleepingBackends()) {
        await sql`select pg_terminate_backend(${pid})`.execute(db);
      }
    });

    it('should cancel the statement and keep the connection for the cancel strategy', async () => {
      const controller = new AbortController();
      const { promise, pid } = await startSleepingQuery(
        controller.signal,
        'cancel query',
      );
      controller.abort();
      expect(await promise).toBeInstanceOf(Error);
      await waitUntil(
        async () => !(await sleepingBackends()).includes(pid),
        'the statement to stop running',
      );
      // Cancelling ends the statement, not the session.
      expect(await backendExists(pid)).toStrictEqual(true);
    });

    it('should terminate the backend for the kill strategy, and leave a working pool', async () => {
      const controller = new AbortController();
      const { promise, pid } = await startSleepingQuery(
        controller.signal,
        'kill session',
      );
      controller.abort();
      expect(await promise).toBeInstanceOf(Error);
      await waitUntil(
        async () => !(await backendExists(pid)),
        'the backend to be terminated',
      );
      const rows = await db
        .selectFrom('kysely_postgrejs_test')
        .selectAll()
        .execute();
      expect(rows).toStrictEqual([]);
    });
  });
  describe('parameter types', () => {
    // Everything here fails when a parameter's type is declared from its
    // JavaScript value - the server needs to resolve it from context, the
    // way it does for pg. Found by running Kysely's own dialect suite.
    it('should let the server type a parameter going into a json column', async () => {
      await sql`create temp table json_param_test (id int, doc json)`.execute(
        db,
      );
      await sql`insert into json_param_test (id, doc) values (1, ${'{"a":1}'})`.execute(
        db,
      );
      const result = await sql<{ doc: any }>`
        select doc from json_param_test`.execute(db);
      expect(result.rows[0].doc).toStrictEqual({ a: 1 });
    });

    it('should let the server unify the types of a coalesce', async () => {
      const result = await sql<{ value: number }>`
        select coalesce(${null}, ${5}) as value`.execute(db);
      expect(Number(result.rows[0].value)).toStrictEqual(5);
    });

    it('should let the server resolve an overloaded operator', async () => {
      const result = await sql<{ value: string }>`
        select ${'a'} || ${'b'} as value`.execute(db);
      expect(result.rows[0].value).toStrictEqual('ab');
    });

    it('should let a number land where the context is not numeric', async () => {
      // Kysely's own suite found these: a declared int4 cannot be
      // coalesced with a varchar column, compared against jsonb, or
      // assigned into one. Leaving the type to the server is what makes
      // all three work.
      await db
        .insertInto('kysely_postgrejs_test')
        .values({ name: 'a', amount: 1 })
        .execute();
      const coalesced = await sql<{ v: unknown }>`
        select coalesce(name, ${5}) as v from kysely_postgrejs_test`.execute(
        db,
      );
      expect(coalesced.rows[0].v).toStrictEqual('a');
      const compared = await sql<{ v: boolean }>`
        select ('{"a":1}'::jsonb->>'a') = ${1} as v`.execute(db);
      expect(compared.rows[0].v).toStrictEqual(true);
    });

    it('should hand back text for a parameter with no context at all', async () => {
      // The cost of the above, and the reason it is worth it only where
      // the server has something to resolve against: with neither a type
      // nor a context, PostgreSQL settles on `text`.
      const bare = await sql<{ v: unknown }>`select ${5} as v`.execute(db);
      expect(bare.rows[0].v).toStrictEqual('5');
    });
  });

  describe('error stacks', () => {
    it('should put the calling file on the stack of a failed query', async () => {
      const error = await db
        .selectFrom('no_such_table' as any)
        .selectAll()
        .execute()
        .catch(e => e);
      expect(error.stack).toContain('postgrejs-dialect.spec.ts');
    });
  });
  describe('fetchAsString', () => {
    it('should decode int8 as a number by default', async () => {
      const result = await sql<{ c: unknown }>`
        select count(*) as c from kysely_postgrejs_test`.execute(db);
      expect(typeof result.rows[0].c).toStrictEqual('number');
    });

    it("should hand back the server's own text for the listed types", async () => {
      // What `pg` does with int8, and what code ported from it expects.
      const strings = new Kysely<TestDatabase>({
        dialect: new PostgrejsDialect({
          pool: new Pool({ max: 1 }),
          fetchAsString: [DataTypeOIDs.int8],
        }),
      });
      try {
        const result = await sql<{ c: unknown; big: unknown }>`
          select count(*) as c, 9007199254740993::int8 as big
          from kysely_postgrejs_test`.execute(strings);
        expect(result.rows[0].c).toStrictEqual('0');
        // Past 2^53 a number could not have carried this back intact.
        expect(result.rows[0].big).toStrictEqual('9007199254740993');
      } finally {
        await strings.destroy();
      }
    });
  });
});
