# kysely-postgrejs

A [Kysely](https://kysely.dev) dialect for [PostgreJS](https://github.com/panates/postgrejs) - run a
Kysely query builder on PostgreJS's wire-protocol client instead of `pg`.

Only the driver is PostgreJS-specific. The SQL is the same either way, so the adapter, introspector
and query compiler are Kysely's own `Postgres*` implementations.

## Install

```sh
npm install kysely-postgrejs kysely postgrejs
```

`kysely` (>=0.29 <0.31) and `postgrejs` (>=3.5) are peer dependencies.

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

## Config

| Option                | Default           | What it does                                                                              |
| --------------------- | ----------------- | ----------------------------------------------------------------------------------------- |
| `pool`                | (required)        | A PostgreJS `Pool`, or a function returning one.                                            |
| `fetchCount`          | `4294967295`      | How many rows a statement may return before the portal suspends. See below.                 |
| `inferParameterTypes` | `true`            | Whether PostgreSQL resolves each parameter's type from context, as it does for `pg`.        |
| `prepare`             | connection's own  | Whether statements are cached as server-side prepared statements. `false` for PgBouncer.    |
| `rollbackOnError`     | `false`           | Whether a failed statement leaves the rest of the transaction usable. See below.            |
| `typeMap`             | `GlobalTypeMap`   | A custom `DataTypeMap`, to override how individual PostgreSQL types are decoded.            |
| `onCreateConnection`  | -                 | Called once per physical connection, before it is first handed to Kysely.                   |
| `onReserveConnection` | -                 | Called every time a connection is acquired from the pool.                                   |

### Why `fetchCount` defaults to "everything"

PostgreJS's `query()` asks for 100 rows by default, and a portal that suspends is not an error: a
`select` of 1000 rows comes back with 100 of them, no error and no flag. The dialect therefore asks
for the protocol maximum instead. Lower it only if you know what a truncated result would mean for
your queries; `streamQuery` ignores it and uses Kysely's `chunkSize` as the cursor's batch size.

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

- **`int8` is a number, not a string.** PostgreJS decodes `bigint` columns as a `number` inside the
  safe integer range and a `BigInt` beyond it, where `pg` hands back a string. This shows up most
  often in `count(*)`, `sum(...)` and other aggregates: `Number(result.count)` works either way,
  `result.count === '2'` does not.
- **A `merge` reports no `numAffectedRows`.** PostgreJS fills the row count for INSERT/UPDATE/DELETE
  only, and nothing is invented to cover that up.
- **`typeMap` is hard to use on PostgreJS 3.5.** `new DataTypeMap(GlobalTypeMap)` does not copy the
  map's OID index, so every column of a query using the copy comes back as a raw `Buffer`. Until
  that is fixed upstream, the way to override a type is `GlobalTypeMap.register(...)`, which
  applies process-wide.

## Kysely's own test suite

Kysely holds its dialects to a suite of some 680 tests. `scripts/run-kysely-suite.sh` checks Kysely
out at a known version, points its `postgres` variant at this dialect instead of the built-in `pg`
one, and runs all of it:

```sh
scripts/run-kysely-suite.sh
```

Against Kysely v0.29.6: **654 passing, 30 failing**, and every failure is accounted for:

| Failures | What                                                                    | Whose                                                     |
| -------- | ----------------------------------------------------------------------- | --------------------------------------------------------- |
| 22       | `merge` queries report no `numAffectedRows`                              | PostgreJS: it fills `rowsAffected` for INSERT/UPDATE/DELETE only |
| 5        | `count`/`sum` return a number where the test expects `pg`'s string        | the `int8` decision above                                   |
| 2        | the error is not an instance of `pg`'s `DatabaseError`, and a test stubs `PostgresDriver.prototype` | the suite identifying the `pg` driver       |
| 1        | a pool error is not `pg`'s "Connection terminated unexpectedly"           | the same                                                    |

The suite is also what settled two design questions. Transaction and savepoint commands go through
`connection.executeQuery` rather than PostgreJS's primitives, because that is the seam Kysely wraps
its logging around - two dozen tests assert the exact statements a transaction runs. And parameter
types are left to the server, because a declared type breaks every context PostgreSQL would have
inferred.

## Status

Under construction. The dialect runs Kysely's query builder, transactions, savepoints, streaming,
introspection and both in-flight abort strategies, and passes Kysely's own dialect suite except for
the rows above.

## License

BSD-3-Clause
