/**
 * What both the in-process timing run and the per-driver heap workers
 * measure - one definition, so the two cannot drift apart.
 *
 * Both sides are Kysely. The control is Kysely's own `PostgresDialect`
 * over `pg`; the subject is this package's `PostgrejsDialect` over
 * PostgreJS. Everything above the driver - the query compiler, the
 * adapter, the plugins - is Kysely's own code in both cases, so the SQL
 * is identical by construction and what is left between the caller and
 * the wire is the driver. That is the property that makes this the
 * cleanest of the four postgrejs adapters to measure through.
 */
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool as PgPool } from 'pg';
import { Pool as PgjsPool } from 'postgrejs';
import { PostgrejsDialect } from '../build/index.js';

export const CONTROL = 'node-postgres';
export const DRIVER = 'postgrejs';

export const SCHEMA = 'bench_kysely';
export const SEED_ROWS = 5000;

/**
 * The dialect's own defaults, stated rather than assumed: no
 * `fetchAsString`, so `int8` arrives as PostgreJS decodes it and not as
 * `pg`'s string. That setting changes what crosses the socket and what
 * gets decoded, so a run that used it would be measuring a different
 * configuration; the results file records which one this was.
 */
export const DIALECT_CONFIG = { fetchAsString: undefined };

/** Built once, so a write scenario times the send and not the making. */
export const BLOB_4MB = Buffer.alloc(4 * 1024 * 1024, 0x78);
export const ARRAY_100K = Array.from(
  { length: 100000 },
  (_, i) => 2147383646 + i,
);

export const CONN = {
  host: process.env.PGHOST ?? '127.0.0.1',
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? 'postgres',
  password: process.env.PGPASSWORD ?? 'postgres',
  database: process.env.PGDATABASE ?? 'postgres',
};

/**
 * Every scenario reads what is already stored, rather than asking the
 * server to build its values on each call, and every one binds at least
 * one parameter.
 *
 * The parameter is usually a `limit` that selects the whole result, and
 * it is there to make the comparison an even one rather than to filter
 * anything: `pg` sends a query with no values over PostgreSQL's simple
 * protocol - `requiresPreparation()` in `pg/lib/query.js` returns false
 * without a name, a row limit or values, and Kysely gives it neither a
 * name nor a row limit - while PostgreJS's `query()` always speaks the
 * extended one. Without a parameter these scenarios would be comparing
 * two protocols rather than two clients.
 *
 * Reading stored values rather than generating them is the same kind of
 * care: a cost both clients pay and neither is measured on compresses
 * the ratio towards 1. Measured in the drizzle round, generating 5000
 * boxes out of random floats read 25.8 ms against 23.8 and said almost
 * nothing; the same rows read back from a table were 4.7 against 3.4.
 */
export const DDL = [
  `create schema if not exists ${SCHEMA}`,

  // the ordinary shapes: point read, page, insert, concurrent reads
  `drop table if exists ${SCHEMA}.rows`,
  `create table ${SCHEMA}.rows (
     id serial primary key,
     name text not null,
     email text not null,
     age integer,
     balance numeric(14, 2),
     created timestamptz not null default now(),
     tags text[],
     meta jsonb,
     active boolean not null default true
   )`,
  `insert into ${SCHEMA}.rows (name, email, age, balance, tags, meta)
     select 'name ' || i, 'user' || i || '@example.com', (i % 80) + 18,
            (i % 100000)::numeric / 100, array['a', 'b', 'c'],
            jsonb_build_object('i', i, 'nested', jsonb_build_object('k', 'v'))
     from generate_series(1, ${SEED_ROWS}) as i`,

  // one 100k-element int4[] whose values use the whole type
  `drop table if exists ${SCHEMA}.arrays`,
  `create table ${SCHEMA}.arrays as
     select array(select 2147383646 + i from generate_series(1, 100000) i) as full_width`,

  // TOAST decompression is not what is being compared, and a sequential
  // int4[] compresses very well
  `alter table ${SCHEMA}.arrays alter column full_width set storage external`,
  `update ${SCHEMA}.arrays set full_width = full_width`,

  // 5000 rows of the types PostgreJS decodes in binary
  `drop table if exists ${SCHEMA}.scalars`,
  `create table ${SCHEMA}.scalars as
     select (random() * 1e9)::float8 as f,
            gen_random_uuid() as u
     from generate_series(1, 5000) i`,

  // the same 5000 float8s as `scalars`, in one row instead of 5000, so
  // the pair differs in shape and in nothing else
  `drop table if exists ${SCHEMA}.float8_array`,
  `create table ${SCHEMA}.float8_array as
     select array_agg(f) as v from ${SCHEMA}.scalars`,
  `alter table ${SCHEMA}.float8_array alter column v set storage external`,
  `update ${SCHEMA}.float8_array set v = v`,

  `drop table if exists ${SCHEMA}.boxes`,
  `create table ${SCHEMA}.boxes as
     select box(point(random() * 1e6, random() * 1e6),
                point(random() * 1e6, random() * 1e6)) as v
     from generate_series(1, 5000) i`,

  // what the write scenarios fill. Unlogged: this measures the client,
  // and a WAL write is the same cost on both sides while being large
  // enough to hide what is not.
  `drop table if exists ${SCHEMA}.writes`,
  `create unlogged table ${SCHEMA}.writes (
     id serial primary key,
     name text,
     email text,
     age integer,
     big bigint,
     balance numeric(20, 6),
     tags text[],
     meta jsonb,
     blob bytea,
     numbers integer[]
   )`,

  // `external` keeps TOAST from compressing it: repeat('x', n) compresses
  // to nothing, and what would then be measured is the decompression
  `drop table if exists ${SCHEMA}.blobs`,
  `create table ${SCHEMA}.blobs (large bytea)`,
  `alter table ${SCHEMA}.blobs alter column large set storage external`,
  `insert into ${SCHEMA}.blobs (large) values (repeat('x', 4194304)::bytea)`,
];

const table = name => sql.raw(`${SCHEMA}.${name}`);

/** Each one is a single Kysely call, the way a caller would write it. */
export const SCENARIOS = [
  {
    name: 'point read',
    group: 'Read',
    note: '1 row of 9 columns',
    iters: 50,
    pairs: 101,
    run: (db, i) =>
      sql`select * from ${table('rows')} where id = ${(i % SEED_ROWS) + 1}`.execute(
        db,
      ),
  },
  /**
   * The same read through the query builder rather than a `sql` tag, to
   * put a number on what the builder costs on top of the driver. Both
   * sides compile it with Kysely's own `PostgresQueryCompiler`, so
   * whatever it costs is paid twice over and cancels out of the ratio -
   * the row is here to say how much of a call is the builder, which is
   * the first question a Kysely user asks of a driver benchmark.
   */
  {
    name: 'point read through the builder',
    group: 'Read',
    note: 'the same row, selected with selectFrom().where() instead of a sql tag',
    iters: 50,
    pairs: 101,
    run: (db, i) =>
      db
        .selectFrom(`${SCHEMA}.rows`)
        .selectAll()
        .where('id', '=', (i % SEED_ROWS) + 1)
        .execute(),
  },
  {
    name: 'page of 200',
    group: 'Read',
    note: '200 rows of 9 columns, mixed types',
    iters: 20,
    pairs: 101,
    run: (db, i) =>
      sql`select * from ${table('rows')} order by id offset ${(i % 10) * 200} limit 200`.execute(
        db,
      ),
  },
  {
    name: 'concurrent reads',
    group: 'Read',
    note: '20 reads at once of 1 row each, pool of 10',
    iters: 4,
    pairs: 61,
    pooled: true,
    run: (db, i) =>
      Promise.all(
        Array.from({ length: 20 }, (_, k) =>
          sql`select * from ${table('rows')} where id = ${((i * 20 + k) % SEED_ROWS) + 1}`.execute(
            db,
          ),
        ),
      ),
  },
  /**
   * A 100k-element `int4[]` whose values use the whole type. PostgreJS
   * reads the column in binary, which costs 8 bytes an element whatever
   * the value; `pg` reads it as text, which costs a byte a digit. So a
   * column of single digits would flatter the text form and one of wide
   * values the binary one - the wide one is the honest setting for a
   * column that exists to hold integers, and the narrow variant is left
   * out rather than averaged in.
   */
  {
    name: 'int4[] of 100k, full width',
    group: 'Read',
    note: '1 row holding 1 array of 100 000 values that use the whole type',
    iters: 3,
    pairs: 41,
    run: db =>
      sql`select full_width as v from ${table('arrays')} limit ${1}`.execute(
        db,
      ),
  },
  {
    name: 'float8 of 5k rows, full width',
    group: 'Read',
    note: '5000 rows of 1 value, eight bytes against seventeen significant digits',
    iters: 10,
    pairs: 61,
    run: db =>
      sql`select f as v from ${table('scalars')} limit ${5000}`.execute(db),
  },
  /**
   * The same values as the row above, in one row rather than 5000. The
   * pair answers a question neither row can alone: what the binary
   * format is worth depends on how many values share a row, not on how
   * many values there are. Spread out, the protocol's per-row cost is
   * most of what either client pays; packed, `pg` has to build the whole
   * array literal as one string and cut a substring per element.
   */
  {
    name: 'float8[] of 5k in one row',
    group: 'Read',
    note: '1 row holding 1 array of the same 5000 values',
    iters: 10,
    pairs: 61,
    run: db =>
      sql`select v from ${table('float8_array')} limit ${1}`.execute(db),
  },
  {
    name: 'uuid of 5k rows',
    group: 'Read',
    note: '5000 rows of 1 value, sixteen bytes against thirty-six characters',
    iters: 10,
    pairs: 61,
    run: db =>
      sql`select u as v from ${table('scalars')} limit ${5000}`.execute(db),
  },
  {
    name: 'box of 5k rows',
    group: 'Read',
    note: '5000 rows of 1 value, four float8s against coordinates that use them',
    iters: 10,
    pairs: 61,
    run: db => sql`select v from ${table('boxes')} limit ${5000}`.execute(db),
  },
  /**
   * A `bytea` has none of the `int4[]` freedom: its text form is
   * `\x`-prefixed hex, two characters a byte, whatever the bytes are. So
   * what varies here is not the encoding's price but whether the payload
   * is big enough to matter next to a round trip.
   */
  {
    name: 'bytea of 4MB',
    group: 'Read',
    note: '1 row holding 1 value of 4 MB',
    iters: 3,
    pairs: 41,
    run: db =>
      sql`select large as v from ${table('blobs')} limit ${1}`.execute(db),
  },
  /**
   * The write side, and it is not the mirror of the read side. A scalar
   * parameter goes out as `BindParam(0, value)` - no declared type, so
   * no binary encoder - which is the dialect's own choice, made so
   * PostgreSQL types each parameter from where it lands. A `Buffer` and
   * an array keep PostgreJS's encoders.
   *
   * Each scenario empties its table before the batch rather than during
   * it, so a growing heap and a growing index are not what is timed.
   */
  {
    name: 'insert one row',
    note: '1 row, six parameters',
    group: 'Write',
    iters: 50,
    pairs: 101,
    setup: db => sql`truncate ${table('writes')}`.execute(db),
    run: (db, i) =>
      sql`insert into ${table('writes')} (name, email, age, balance, tags, meta)
          values (${'n' + i}, ${'e' + i + '@example.com'}, ${(i % 60) + 18},
                  ${'12.34'}, ${'{a,b}'}, ${'{"i":1}'})
          returning id`.execute(db),
  },
  {
    name: 'insert 500 rows',
    note: '500 rows in 1 statement, 2500 parameters that fill their types',
    group: 'Write',
    iters: 4,
    pairs: 61,
    setup: db => sql`truncate ${table('writes')}`.execute(db),
    run: (db, i) => {
      // wide on purpose: a row of short values measures the round trip
      // rather than anything either client does with the values in it
      const values = [];
      for (let k = 0; k < 500; k++)
        values.push(
          sql`(${'name-' + i + '-' + k + '-'.padEnd(40, 'x')},
               ${'user' + k + '@an-example-domain-that-is-long.example.com'},
               ${(k % 60) + 18},
               ${String(9007199254740990n + BigInt(k))},
               ${'123456789012.345678'})`,
        );
      return sql`insert into ${table('writes')} (name, email, age, big, balance)
                 values ${sql.join(values, sql`, `)}`.execute(db);
    },
  },
  {
    /**
     * **Read the allocation column, not the clock.**
     *
     * Measured by running the same insert with the payload generated
     * server-side, so the send costs nothing: 13.25 ms against the 19.47 the
     * full call takes, which puts **two thirds of this row's clock in
     * PostgreSQL** writing 4 MB. The remaining third is two clients pushing
     * bytes through a socket at the same speed - isolated in
     * `../postgrejs-typeorm`, where `select length($1::bytea)` on the same
     * payload is 1.03x. So the 1.12x here is mostly not either driver, and a
     * reader who takes it for one has been misled by the row.
     *
     * What *is* a client measurement is what it costs to get those bytes
     * out, and on this driver that is a loss rather than a win - which is
     * the other reason to keep the row.
     */
    name: 'insert a 4MB bytea',
    note: '1 row holding 1 value of 4 MB - the clock is mostly the server',
    group: 'Write',
    iters: 3,
    pairs: 41,
    setup: db => sql`truncate ${table('writes')}`.execute(db),
    run: db =>
      sql`insert into ${table('writes')} (blob) values (${BLOB_4MB})`.execute(
        db,
      ),
  },
  {
    name: 'insert a 100k int4[]',
    note: '1 row holding 1 array of 100 000 values, text on both sides',
    group: 'Write',
    iters: 3,
    pairs: 41,
    setup: db => sql`truncate ${table('writes')}`.execute(db),
    run: db =>
      sql`insert into ${table('writes')} (numbers) values (${ARRAY_100K})`.execute(
        db,
      ),
  },
  {
    name: 'twenty inserts in a transaction',
    note: '20 rows, one statement each, inside one transaction',
    group: 'Write',
    iters: 4,
    pairs: 61,
    setup: db => sql`truncate ${table('writes')}`.execute(db),
    run: (db, i) =>
      db.transaction().execute(async trx => {
        for (let k = 0; k < 20; k++)
          await sql`insert into ${table('writes')} (name, age)
                    values (${'n' + i + '-' + k}, ${k})`.execute(trx);
      }),
  },
];

/**
 * A Kysely instance per driver, and its pool, so a caller can close what
 * it opened. `max` is 1 except for the scenario that is about a pool.
 */
export function openDatabases(pooled = false) {
  const max = pooled ? 10 : 1;
  const pgPool = new PgPool({ ...CONN, max });
  const jsPool = new PgjsPool({ ...CONN, pool: { max } });
  return {
    dbs: {
      [CONTROL]: new Kysely({ dialect: new PostgresDialect({ pool: pgPool }) }),
      [DRIVER]: new Kysely({ dialect: new PostgrejsDialect({ pool: jsPool }) }),
    },
    async close() {
      await pgPool.end();
      await jsPool.close(true);
    },
  };
}

/**
 * The SQL each scenario actually sends, captured rather than restated:
 * every `run` is called once against a Kysely whose `log` records the
 * compiled query, so what is printed cannot drift from what is measured.
 * That is also the seam Kysely wraps around `executeQuery`, so a
 * statement the dialect sends any other way would be missing here.
 */
export async function describeScenarios(scenarios) {
  const captured = [];
  const pool = new PgjsPool({ ...CONN, pool: { max: 1 } });
  const db = new Kysely({
    dialect: new PostgrejsDialect({ pool }),
    log: event => {
      if (event.level === 'query')
        captured.push({
          query: event.query.sql,
          params: event.query.parameters,
        });
    },
  });
  const described = [];
  for (const scenario of scenarios) {
    if (scenario.setup) await scenario.setup(db);
    captured.length = 0;
    await scenario.run(db, 0);
    // the concurrent scenario fires twenty of the same statement, and a
    // transaction's begin/commit are captured with it
    const { query, params } = captured[0] ?? { query: '?', params: [] };
    described.push({ scenario, query, params, calls: captured.length });
  }
  await db.destroy();
  return described;
}

export const scenariosMatching = only =>
  SCENARIOS.filter(
    s => !only || only === 'all' || s.name.replaceAll(' ', '-').includes(only),
  );
