# kysely-postgrejs

A [Kysely](https://kysely.dev) dialect for [PostgreJS](https://github.com/panates/postgrejs) - run a
Kysely query builder on PostgreJS's wire-protocol client instead of `pg`.

Only the driver is PostgreJS-specific. The SQL is the same either way, so the adapter, introspector
and query compiler are Kysely's own `Postgres*` implementations.

## Install

```sh
npm install kysely-postgrejs kysely postgrejs
```

`kysely` (>=0.29 <0.31) and `postgrejs` (>=3.10) are peer dependencies.

## Usage

```ts
import { Kysely } from 'kysely';
import { Pool } from 'postgrejs';
import { PostgrejsDialect } from 'kysely-postgrejs';

const db = new Kysely<Database>({
  dialect: new PostgrejsDialect({
    pool: new Pool('postgres://localhost:5432/mydb'),
  }),
});
```

`pool` takes a `Pool` instance, or an async function returning one - it is called once, when the
driver initialises. `db.destroy()` closes the pool.

Streaming goes through a server-side cursor, with Kysely's chunk size as the cursor's batch size:

```ts
for await (const person of db.selectFrom('person').selectAll().stream(100)) {
  // one round trip per 100 rows; the cursor closes when the loop ends,
  // whether it runs out, breaks, or throws
}
```

COPY, LISTEN/NOTIFY, large objects and logical replication are all a method call away: the two
hooks hand you the PostgreJS connection underneath, with its full API intact.

```ts
new PostgrejsDialect({
  pool,
  onCreateConnection: async (connection) => {
    const postgrejs = (connection as PostgrejsConnection).connection;
    await postgrejs.query(`set application_name = 'reports'`);
  },
});
```

The pool you passed in is of course still yours to `acquire()` from directly as well.

## Config

| Option                | Default           | What it does                                                                              |
| --------------------- | ----------------- | ----------------------------------------------------------------------------------------- |
| `pool`                | (required)        | A PostgreJS `Pool`, or a function returning one.                                            |
| `fetchAsString`       | -                 | OIDs to hand back as the server's own text. `[DataTypeOIDs.int8]` is how to get `pg`'s bigints. |
| `fetchCount`          | `4294967295`      | How many rows a statement may return before the portal suspends. See below.                 |
| `inferParameterTypes` | `true`            | Whether parameters go to the server untyped, for PostgreSQL to resolve from context.        |
| `prepare`             | connection's own  | Whether statements are cached as server-side prepared statements. `false` for PgBouncer.    |
| `rollbackOnError`     | `false`           | Whether a failed statement leaves the rest of the transaction usable. See below.            |
| `typeMap`             | `GlobalTypeMap`   | A custom `DataTypeMap`, to override how individual PostgreSQL types are decoded.            |
| `onCreateConnection`  | -                 | Called once per physical connection, before it is first handed to Kysely.                   |
| `onReserveConnection` | -                 | Called every time a connection is acquired from the pool.                                   |

### Complete results by default

`fetchCount` is set to the protocol maximum, so every row a statement produces comes back in one
result and a row count is a row count. Lower it when you want a statement to stop early and you
know what a short result means for your queries. Streaming is unaffected: `streamQuery` works from
Kysely's `chunkSize`, which becomes the cursor's batch size.

### Parameters take their type from where they appear

Strings, numbers, booleans, bigints and nulls go to the server untyped, exactly as `pg` sends them,
so PostgreSQL resolves each one from the position it appears in. The same value is a `varchar` next
to a `varchar` column, a `jsonb` next to a `jsonb` one, and an `int4` in arithmetic - which is what
keeps `coalesce`, `json` and `jsonb` operators, string concatenation, overloaded functions and
subscripted assignment working with a plain JavaScript argument:

```ts
await sql`select coalesce(nickname, ${'anonymous'}) from person`.execute(db);
```

Dates, buffers, arrays and objects keep PostgreJS's typed binary encoders, which is what makes them
compact on the wire.

A parameter standing on its own has nothing to resolve against, and PostgreSQL settles on `text`
there:

```ts
await sql`select ${5} as v`.execute(db); // '5'
await sql`select ${5} + 1 as v`.execute(db); // 6 - the context decides
```

`inferParameterTypes: false` declares each type from the JavaScript value instead.

### Getting `pg`'s bigints

PostgreJS decodes `int8` as a number inside the safe integer range and a `BigInt` beyond it, where
`pg` hands back a string - which is what Kysely's generated types and most code ported from `pg`
expect, `count(*)` and `sum(...)` above all. One line asks for the same thing:

```ts
import { DataTypeOIDs } from 'postgrejs';

new PostgrejsDialect({ pool, fetchAsString: [DataTypeOIDs.int8] });
```

The server renders those columns as text and the dialect hands them over untouched, so a value past
2^53 keeps every digit. Any OID works - `numeric`, `date`, `json` - and nothing else is affected.

### PostgreSQL's own transaction semantics

Inside a transaction a failed statement aborts the transaction, the way PostgreSQL and `pg` behave,
so code written against either keeps working unchanged. PostgreJS can instead wrap each statement in
a savepoint of its own and leave the transaction usable afterwards: `rollbackOnError: true` opts
into that.

## Aborting a query

Pass a signal, and pick what should happen to the statement already running on the server:

```ts
const controller = new AbortController();

await db.selectFrom('person').selectAll().execute({
  signal: controller.signal,
  inflightQueryAbortStrategy: 'cancel query', // or 'kill session'
});
```

Both strategies are supported, and neither queues behind the pool:

- **`'cancel query'`** sends a CancelRequest, which the protocol carries on a connection of its own.
  The statement rejects with PostgreSQL's `57014` and the connection stays usable. Kysely's `pg`
  dialect has to run `pg_cancel_backend()` from a second connection instead - either a dedicated
  client or, failing that, one it waits for the pool to free.
- **`'kill session'`** runs `pg_terminate_backend()` from a session opened for the occasion. The
  query, its transaction and its locks go with the backend; the pool notices the closed connection
  and replaces it.

The default, `'ignore query'`, stops waiting and leaves the statement running - no dialect support
is involved.

## Differences from Kysely's `pg` dialect

- **`int8` is a number, not a string, unless you ask.** The default is PostgreJS's own decoding;
  `fetchAsString: [DataTypeOIDs.int8]` gives you `pg`'s strings. See above.
- **Errors are PostgreJS's `DatabaseError`,** not `pg`'s. The PostgreSQL `code` (`23505`, `42P01`)
  is the same and is what to match on; `instanceof` against `pg`'s class is not.

## Kysely's own test suite

Kysely holds its dialects to a suite of several hundred tests. `scripts/run-kysely-suite.sh` checks Kysely
out at a known version, points its `postgres` variant at this dialect instead of the built-in `pg`
one, and runs all of it:

```sh
scripts/run-kysely-suite.sh
```

Against Kysely v0.29.6: **684 passing, nothing failing** - the same number Kysely's own `pg` dialect
scores on that checkout, with no test skipped. Against v0.30.0-beta.2, the other end of the peer
range: **728 passing, nothing failing**.

Two of those tests name the `pg` driver itself: one asserts the error is an instance of `pg`'s
`DatabaseError`, and one stubs `PostgresDriver.prototype` and expects the stub to be called. The
patch points both at this dialect's equivalents, so they exercise the same behaviour here that they
exercise for `pg`.

The suite also runs with `fetchAsString: [DataTypeOIDs.int8]`, since every expectation in it is
written against `pg`'s string bigints.

A weekly CI job re-runs both and fails if either count moves in either direction.

The suite is also what settled two design decisions. Transaction and savepoint commands go through
`connection.executeQuery`, the seam Kysely wraps its logging around, so `log` and `db.on('query')`
see every `BEGIN`, `SAVEPOINT` and `COMMIT` - two dozen tests assert the exact statements a
transaction runs. And parameter types are left to the server, which is what keeps a parameter usable
in every context PostgreSQL can infer a type from.

## Use from a MikroORM driver

MikroORM's SQL layer runs on Kysely, so a custom driver only has to hand this dialect over:

```ts
import { PostgrejsDialect } from 'kysely-postgrejs';

class PostgrejsSqlConnection extends AbstractSqlConnection {
  createKyselyDialect() {
    // `pool` being whichever PostgreJS pool the driver manages
    return new PostgrejsDialect({ pool });
  }
}
```

Nothing the dialect needs is behind a deep import: `PostgrejsDialect`, `PostgrejsDriver`,
`PostgrejsConnection` and the config types are all exported from the package root.

## Development

The unit tests need nothing; the live ones need a PostgreSQL at `127.0.0.1:5432`
(`postgres`/`postgres`, database `postgres`), which `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD` and
`PGDATABASE` override.

```sh
npm test          # unit + live tests
npm run citest    # the same, with coverage
npm run qc        # lint and circular dependency check
npm run compile   # type check without emitting

scripts/run-kysely-suite.sh   # Kysely's own suite, on its own database
```

## Status

Released and complete: the query builder, transactions, savepoints, streaming, introspection and
both in-flight abort strategies all work against a live server, and Kysely's own dialect suite
passes in full on both ends of the supported range.

## License

BSD-3-Clause
