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

### Why `rollbackOnError` defaults to `false`

PostgreJS wraps every statement inside a transaction in a savepoint of its own, so a failed
statement leaves the transaction usable. That is not what PostgreSQL does, nor what `pg` - and
therefore every existing Kysely user - expects. The dialect turns it off: a failed statement aborts
the transaction. Set it back to `true` to opt into PostgreJS's behaviour.

## Differences from Kysely's `pg` dialect

- **`int8` is a number, not a string.** PostgreJS decodes `bigint` columns as a `number` inside the
  safe integer range and a `BigInt` beyond it, where `pg` hands back a string. Pass your own
  `typeMap` if you need something else.
- **A `merge` reports no `numAffectedRows`.** PostgreJS fills the row count for INSERT/UPDATE/DELETE
  only, and nothing is invented to cover that up.
- **Savepoint names are stricter.** They go through PostgreJS's own savepoint primitives, which
  accept `/^[a-zA-Z]\w+$/` - a leading underscore, a dash or a single-character name is rejected
  here and would not be by `pg`.

## Status

Under construction. The dialect runs Kysely's query builder, transactions, savepoints, streaming and
introspection against a live server today. Still to come: the abort/cancellation surface
(`cancelQuery`, `killSession`), and a run against Kysely's own dialect test suite.

## License

BSD-3-Clause
