import { expect } from 'expect';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool as PgPool } from 'pg';
import { Pool } from 'postgrejs';
import { PostgrejsDialect } from '../../src/postgrejs-dialect.js';

/**
 * The same query through this dialect and through Kysely's own
 * `PostgresDialect` over `pg`, so the README's "What changes when you
 * switch" table is a test rather than a note. Everything above the
 * driver is Kysely's own code on both sides, so a difference here is a
 * difference between the two clients and nothing else.
 *
 * A row that says `same` is the stronger claim of the two: it is what
 * keeps code ported from `pg` working, and it is what would break
 * quietly if a decoder changed underneath.
 */
describe('value shapes against pg (live)', () => {
  let ours: Kysely<any>;
  let theirs: Kysely<any>;

  const shape = (value: unknown): string => {
    if (value === null) return 'null';
    if (typeof value === 'bigint') return `bigint ${value}`;
    if (Buffer.isBuffer(value)) return `Buffer<${value.toString('hex')}>`;
    if (value instanceof Date) return `Date ${value.toISOString()}`;
    if (Array.isArray(value)) return `[${value.map(shape).join(', ')}]`;
    if (typeof value === 'object') {
      const name = value.constructor?.name ?? 'Object';
      return `${name} ${JSON.stringify(value)}`;
    }
    return `${typeof value} ${JSON.stringify(value)}`;
  };

  const read = async (db: Kysely<any>, text: string) => {
    const result = await sql.raw<{ v: unknown }>(text).execute(db);
    return result.rows[0].v;
  };

  before(() => {
    const connection = {
      host: process.env.PGHOST,
      port: Number(process.env.PGPORT),
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      database: process.env.PGDATABASE,
    };
    ours = new Kysely({
      dialect: new PostgrejsDialect({ pool: new Pool({ ...connection }) }),
    });
    theirs = new Kysely({
      dialect: new PostgresDialect({ pool: new PgPool({ ...connection }) }),
    });
  });

  after(async () => {
    await ours?.destroy();
    await theirs?.destroy();
  });

  /** What both clients answer identically - the table's silent majority. */
  const IDENTICAL: [string, string][] = [
    ['text', `select 'abc'::text as v`],
    ['float8', `select 1.5::float8 as v`],
    ['boolean', `select true as v`],
    ['date', `select '2026-09-30'::date as v`],
    ['timestamptz', `select '2026-09-30T10:00:00Z'::timestamptz as v`],
    ['json', `select '{"a":1}'::json as v`],
    ['jsonb', `select '{"a":1}'::jsonb as v`],
    ['uuid', `select '00000000-0000-0000-0000-000000000001'::uuid as v`],
    ['bytea', `select '\\x0102'::bytea as v`],
    ['text[]', `select array['a','b']::text[] as v`],
    ['int4[]', `select array[1,2]::int4[] as v`],
    ['inet', `select '10.0.0.1'::inet as v`],
    ['bit', `select B'101'::bit(3) as v`],
  ];

  for (const [name, text] of IDENTICAL)
    it(`should answer the same as pg for ${name}`, async () => {
      expect(shape(await read(ours, text))).toEqual(
        shape(await read(theirs, text)),
      );
    });

  /**
   * And where they differ, which is the half the README has to print.
   * `pg` renders most of these as the server's own text; PostgreJS
   * decodes them into a JavaScript value or one of its own classes.
   */
  const DIFFERENT: { name: string; sql: string; pg: string; ours: string }[] = [
    {
      name: 'int8 inside the safe range',
      sql: `select count(*) as v from (values (1),(2)) t(x)`,
      pg: 'string "2"',
      ours: 'number 2',
    },
    {
      name: 'int8 beyond it',
      sql: `select 9007199254740993::int8 as v`,
      pg: 'string "9007199254740993"',
      ours: 'bigint 9007199254740993',
    },
    {
      name: 'numeric',
      sql: `select 12.34::numeric(10,2) as v`,
      pg: 'string "12.34"',
      ours: 'number 12.34',
    },
    {
      name: 'money',
      sql: `select 12.34::money as v`,
      pg: 'string "$12.34"',
      ours: 'number 12.34',
    },
    {
      name: 'time',
      sql: `select '10:20:30'::time as v`,
      pg: 'string "10:20:30"',
      ours: 'Date 1970-01-01T08:20:30.000Z',
    },
    {
      name: 'int4range',
      sql: `select '[1,5)'::int4range as v`,
      pg: 'string "[1,5)"',
      ours: 'Range {"lower":1,"upper":5,"lowerInclusive":true,"upperInclusive":false,"isEmpty":false}',
    },
    {
      name: 'point',
      sql: `select '(1,2)'::point as v`,
      pg: 'Object {"x":1,"y":2}',
      ours: 'Point {"x":1,"y":2}',
    },
    {
      name: 'circle',
      sql: `select '<(1,2),3>'::circle as v`,
      pg: 'Object {"x":1,"y":2,"radius":3}',
      ours: 'Circle {"x":1,"y":2,"radius":3}',
    },
    {
      name: 'box',
      sql: `select '(1,2),(3,4)'::box as v`,
      pg: 'string "(3,4),(1,2)"',
      ours: 'Box {"x1":3,"y1":4,"x2":1,"y2":2}',
    },
    {
      name: 'line',
      sql: `select '{1,2,3}'::line as v`,
      pg: 'string "{1,2,3}"',
      ours: 'Line {"a":1,"b":2,"c":3}',
    },
    {
      name: 'lseg',
      sql: `select '[(1,2),(3,4)]'::lseg as v`,
      pg: 'string "[(1,2),(3,4)]"',
      ours: 'LineSegment {"x1":1,"y1":2,"x2":3,"y2":4}',
    },
    {
      name: 'path',
      sql: `select '[(1,2),(3,4)]'::path as v`,
      pg: 'string "[(1,2),(3,4)]"',
      ours: 'Path {"points":[{"x":1,"y":2},{"x":3,"y":4}],"isClosed":false}',
    },
    {
      name: 'polygon',
      sql: `select '((1,2),(3,4),(5,6))'::polygon as v`,
      pg: 'string "((1,2),(3,4),(5,6))"',
      ours: 'Polygon {"points":[{"x":1,"y":2},{"x":3,"y":4},{"x":5,"y":6}]}',
    },
  ];

  for (const testCase of DIFFERENT)
    it(`should differ from pg on ${testCase.name}, as documented`, async () => {
      expect(shape(await read(theirs, testCase.sql))).toEqual(testCase.pg);
      expect(shape(await read(ours, testCase.sql))).toEqual(testCase.ours);
    });

  /**
   * The one difference the README tells people how to undo, so it is
   * worth asserting that the cure works through Kysely and not only on
   * the client.
   */
  it('should hand back pg-shaped bigints when asked', async () => {
    const asString = new Kysely<any>({
      dialect: new PostgrejsDialect({
        pool: new Pool({
          host: process.env.PGHOST,
          port: Number(process.env.PGPORT),
          user: process.env.PGUSER,
          password: process.env.PGPASSWORD,
          database: process.env.PGDATABASE,
        }),
        fetchAsString: [20],
      }),
    });
    try {
      const text = `select 9007199254740993::int8 as v`;
      expect(shape(await read(asString, text))).toEqual(
        shape(await read(theirs, text)),
      );
    } finally {
      await asString.destroy();
    }
  });
});
