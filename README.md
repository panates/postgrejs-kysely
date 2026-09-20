# kysely-postgrejs

A [Kysely](https://kysely.dev) dialect for [PostgreJS](https://github.com/panates/postgrejs) - run a
Kysely query builder on PostgreJS's wire-protocol client instead of `pg`.

Only the driver is PostgreJS-specific. The SQL is the same either way, so the adapter, introspector
and query compiler are Kysely's own `Postgres*` implementations.

## Install

```sh
npm install kysely-postgrejs kysely postgrejs
```

`kysely` (>=0.29 <0.31) and `postgrejs` (>=3.6) are peer dependencies.

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

Everything Kysely's interface does not reach - COPY, LISTEN/NOTIFY, large objects, logical
replication - is still there on the PostgreJS connection underneath, which the two hooks hand you:

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
| `inferParameterTypes` | `true`            | Whether PostgreSQL resolves each parameter's type from context, as it does for `pg`.        |
| `prepare`             | connection's own  | Whether statements are cached as server-side prepared statements. `false` for PgBouncer.    |
| `rollbackOnError`     | `false`           | Whether a failed statement leaves the rest of the transaction usable. See below.            |
| `typeMap`             | `GlobalTypeMap`   | A custom `DataTypeMap`, to override how individual PostgreSQL types are decoded.            |
| `onCreateConnection`  | -                 | Called once per physical connection, before it is first handed to Kysely.                   |
| `onReserveConnection` | -                 | Called every time a connection is acquired from the pool.                                   |

### Why `fetchCount` defaults to "everything"

The dialect asks for the protocol maximum rather than leaving the limit unsaid. Kysely's
`QueryResult` has nowhere to report that rows were left behind, so a truncated result would reach
the caller as a short answer with nothing wrong about it - PostgreJS flags one with `suspended`, and
that flag has no way through. Lower it only if you know what a short result would mean for your
queries; `streamQuery` ignores it and uses Kysely's `chunkSize` as the cursor's batch size.

### Why parameter types are left to the server

PostgreJS gives every parameter a type OID taken from its JavaScript value, so a string arrives
declared as `varchar`. That is a declaration, not a hint, and PostgreSQL stops inferring:

```ts
await db.insertInto('log').values({ payload: '{"a":1}' }).execute()
// column "payload" is of type json but expression is of type character varying
```

`coalesce($1, 1)`, `$1 || name` and any call to an overloaded function fail the same way. `pg` sends
type 0 - unspecified - and lets PostgreSQL resolve each parameter from where it appears, so none of
this surfaces there. The dialect does the same by default. Only strings, numbers, booleans, bigints
and nulls are affected; dates, buffers, arrays and objects keep PostgreJS's typed, binary encoding,
which is both correct and faster. Set `inferParameterTypes: false` to declare types again.

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

### Why `rollbackOnError` defaults to `false`

PostgreJS wraps every statement inside a transaction in a savepoint of its own, so a failed
statement leaves the transaction usable. That is not what PostgreSQL does, nor what `pg` - and
therefore every existing Kysely user - expects. The dialect turns it off: a failed statement aborts
the transaction. Set it back to `true` to opt into PostgreJS's behaviour.

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

Against Kysely v0.29.6: **683 passing, 1 failing**. Against v0.30.0-beta.2, the other end of the
peer range: **727 passing, the same 1 failing**. For comparison, the same checkout against Kysely's
own `pg` dialect passes 684 - the same tests, none of them skipped.

The one failure asserts that the pool's last error reads "Connection terminated unexpectedly", which
is `pg`'s wording after a killed session. PostgreJS 3.6 emits nothing at all there: it destroys the
connection and opens another. The kill itself works - the test's own check that the query is gone
passes first. PostgreJS has since grown a `ConnectionLostError` (SQLSTATE `08006`, carrying the
backend's `processID`) that its pool reports on `'error'` and `'destroy'`, and with that build the
suite passes all 684 - the same number as Kysely's own `pg` dialect. These numbers move to
**684 / 0** and **728 / 0** when that release lands and the peer floor moves with it.

Two other tests name the `pg` driver rather than describe behaviour: one asserts the error is an
instance of `pg`'s `DatabaseError`, and one stubs `PostgresDriver.prototype` and expects the stub to
be called. The patch points both at this dialect's equivalents, which is what makes them test
anything at all here - left alone they would pass over the behaviour without exercising it.

The suite also runs with `fetchAsString: [DataTypeOIDs.int8]`, since every expectation in it is
written against `pg`'s string bigints.

A weekly CI job re-runs both, and fails if that count moves in either direction - the failures are
known, so what matters is whether the set of them changed.

The suite is also what settled two design questions. Transaction and savepoint commands go through
`connection.executeQuery` rather than PostgreJS's primitives, because that is the seam Kysely wraps
its logging around - two dozen tests assert the exact statements a transaction runs. And parameter
types are left to the server, because a declared type breaks every context PostgreSQL would have
inferred.

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

Pre-1.0, and complete enough to use: the query builder, transactions, savepoints, streaming,
introspection and both in-flight abort strategies all work against a live server, and Kysely's own
dialect suite passes every test that is not asserting the identity of the `pg` driver.

## License

BSD-3-Clause
