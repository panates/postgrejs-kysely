import { expect } from 'expect';
import { type Generated, Kysely, sql } from 'kysely';
import { Pool } from 'postgrejs';
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

  it("should return every row of a result larger than PostgreJS's default batch", async () => {
    // The regression this dialect exists to avoid: a plain PostgreJS
    // query() stops at 100 rows and reports neither an error nor a flag.
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
});
