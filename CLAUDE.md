# postgrejs-kysely

A [Kysely](https://kysely.dev) dialect for [PostgreJS](https://github.com/panates/postgrejs), so a Kysely
query builder can run on PostgreJS's wire-protocol client instead of `pg`.

The same dialect is what a MikroORM driver needs: MikroORM's SQL layer runs on Kysely, and a custom driver
only has to implement `AbstractSqlConnection.createKyselyDialect()`. Keep that in mind when deciding what
belongs in the public export surface - a second package should be able to hand this dialect straight to
MikroORM without reaching into internals.

## What Kysely asks for

`Dialect` (pass it as `KyselyConfig.dialect`): `createAdapter()`, `createDriver()`, `createIntrospector()`,
`createQueryCompiler()`. For PostgreSQL the adapter/introspector/compiler can extend Kysely's own
`PostgresAdapter`, `PostgresIntrospector` and `PostgresQueryCompiler` - the real work is the driver.

`Driver`: `init()`, `acquireConnection()`, `beginTransaction()`, `commitTransaction()`,
`rollbackTransaction()`, `releaseConnection()`, `destroy()`, plus optional `savepoint()`,
`rollbackToSavepoint()`, `releaseSavepoint()` - Kysely calls those three as `driver.savepoint?.()`, so
leaving them out makes `trx.savepoint()` silently do nothing rather than fail.

**Every one of them sends SQL through `connection.executeQuery`, never PostgreJS's same-named
primitives.** `RuntimeDriver` monkey-patches `executeQuery` on each connection it hands out to add
logging, so a `BEGIN` sent any other way never reaches the `log` callback, `db.on('query')`, or anything
built on that seam - two dozen of Kysely's own suite tests assert the exact statements a transaction
runs. Savepoint names go through `compileQuery` as an `IdentifierNode`, which is also how the name gets
quoted (Kysely keeps `parseSavepointCommand` internal; `RawNode` and `IdentifierNode` are exported).

`DatabaseConnection`: `executeQuery<R>(compiledQuery, options?)` is required; `streamQuery<R>(compiledQuery,
chunkSize, options?)` returns an `AsyncIterableIterator<QueryResult<R>>`. Optional `cancelQuery`,
`collectSessionInfo`, `killSession`.

Kysely's `QueryResult`: `rows: O[]` (always defined, empty when there are none), and optional
`insertId`, `numAffectedRows`, `numChangedRows` - all three **bigint**, not number.

## What PostgreJS gives you

Source of truth is the repo at `../../oslib/postgrejs` (its own `CLAUDE.md` describes the internals).
The facts below were checked against a live server on PostgreJS 3.6, not recalled - the peer range
starts there, so nothing has to account for 3.5 any more.

**`connection.query(sql, options)` returns every row** since 3.6 - `fetchCount` defaults to 0, which
is the protocol's "no limit", and a result that was truncated carries `suspended: true`. (Before 3.6
the default was 100 and a truncated result said nothing at all, which is the hazard the explicit
`MAX_FETCH_COUNT` was written against.) The dialect keeps passing it: Kysely's `QueryResult` has
nowhere to carry `suspended`, so a short result would reach the caller looking complete.

**Rows are arrays by default.** Kysely wants objects, so pass `objectRows: true` (or `rowDecoder:
'object'`). `QueryResult` from PostgreJS carries `command`, `fields`, `rowType`, `rows`, and
`rowsAffected` for INSERT/UPDATE/DELETE and MERGE - a **number**, so convert to bigint for Kysely's
`numAffectedRows`.

**Parameters are `$1`-style**, passed as `options.params`, so Kysely's `CompiledQuery` needs no
rewriting - but their **types** do. `Connection._query` derives an OID per parameter with
`typeMap.determine(value)`, so a string arrives declared as `varchar` and PostgreSQL stops
inferring:
inserting into a `json` column, `coalesce($1, 1)`, `$1 || x` and any overloaded function all fail. `pg`
sends OID 0 (unspecified) and lets the server resolve the parameter from context. Wrapping a value in
`new BindParam(0, value)` asks PostgreJS for the same thing - `paramTypes[i] || 0` in Parse, the text
branch in Bind - and that is what the dialect does for strings, numbers, booleans, bigints and nulls.
Dates, buffers, arrays and objects keep PostgreJS's typed binary encoders; their text form is not
something the server could parse out of context.

**Streaming is a cursor.** `query(sql, { cursor: true })` puts a `Cursor` on `result.cursor`, which has
`next()`, `fetch(n)`, `close()`, `isClosed`, `Symbol.asyncDispose` and `Symbol.asyncIterator`. Iterating
it with `for await` closes it when the loop ends - by exhaustion, a `break`, or a throw. `fetchCount`
sets the batch size, which is what `streamQuery`'s `chunkSize` should map to.

**Transactions.** `startTransaction()` / `commit()` / `rollback()` are depth-counted, and
`savepoint(name)` validates the name. The dialect uses none of them (see above), and nothing
breaks: `inTransaction` reads the server's own transaction status rather than the depth counter, and
`TRANSACTION_COMMAND_PATTERN` recognises BEGIN/COMMIT/SAVEPOINT in a statement, so PostgreJS's
bookkeeping stays in step with SQL sent past it.

Every statement inside a transaction is otherwise wrapped in a savepoint of its own (`rollbackOnError`,
on by default), so one failed statement leaves the transaction usable - which is neither PostgreSQL's
behaviour nor what a Kysely user expects. The dialect passes `rollbackOnError: false` on every query.

**Pool.** `pool.acquire()` / `pool.release(connection)` is the pair `acquireConnection`/`releaseConnection`
maps onto. Do not build the driver on `pool.query()`: it is free to pick a different connection per call,
which would scatter a transaction across connections.

**Prepared statements are cached per connection**, automatically, from the second use of the same SQL.
`prepare: false` on a call or in the connection config opts out - needed for PgBouncer in transaction
pooling mode before 1.21, where a named statement does not survive to the next call. Worth exposing as a
dialect option.

**Errors** are `DatabaseError` with a PostgreSQL `code` (`42P01`, `23505`, …), `message`, and `position`.
Kysely passes errors through, so there is nothing to map, but the code is what users will match on.

**Types.** The extended query path is binary per column by default and covers all built-in types;
`columnFormat` forces text if ever needed. `int8` comes back as a number inside the safe range and a
BigInt beyond it, where `pg` hands back a string - which is what the suite's `count`/`sum` expectations
are built on, and what `fetchAsString: [DataTypeOIDs.int8]` asks for - it takes any OID and has the
server render those columns as text. `typeMap` takes a custom `DataTypeMap`, and copying
`GlobalTypeMap` to override a type or two works.

**Cancellation.** Every call takes an `AbortSignal` as `options.signal`, and `connection.cancel()` cancels
out of band. Those are what Kysely's `AbortableOperationOptions` and optional `cancelQuery` map to.

## Settled decisions

Chosen deliberately, and not worth re-opening without new evidence:

- `rollbackOnError: false` on every query - PostgreSQL's semantics, not PostgreJS's.
- `fetchCount` defaults to the protocol maximum: Kysely cannot carry PostgreJS's `suspended`, so a
  short result would look complete.
- Parameter types are left to the server; `inferParameterTypes: false` opts out.
- Transaction and savepoint commands go through `executeQuery`, so Kysely can see them.
- `int8` stays PostgreJS-native (number, then BigInt) by default; `fetchAsString: [DataTypeOIDs.int8]`
  is the opt-in for `pg`'s strings, passed straight through to PostgreJS.
- The config takes a `Pool` or an async factory - no connection string, no bare `Connection`.
- `cancelQuery` uses PostgreJS's out-of-band `cancel()`; `killSession` opens its own session from
  `connection.config` rather than borrowing one from the pool.
- `collectSessionInfo` is left unimplemented on purpose: the pid is already on the connection, and
  Kysely skips the hook when it is absent, saving a round trip.
- Peer range is `kysely >=0.29 <0.31`; the `Dialect`, `Driver` and `DatabaseConnection` interfaces are
  byte-identical between 0.29.6 and 0.30.0-beta.2.

## Layout and tests

`src/` is five files: the dialect, the driver, the connection, the config types and `constants.ts`.

- `test/A-common/` - unit tests against the fakes in `test/_support/fakes.ts`. A fake connection records
  every call and can hold a query open, which is how the abort handlers and the option plumbing are
  tested without a server.
- `test/B-live/` - the same behaviour against a live PostgreSQL, including the 1000-row truncation
  regression and both abort strategies (asserted against `pg_stat_activity`, not just the promise).
- Code style follows the PostgreJS repo's own `CLAUDE.md`: member order, `protected` over `private`.
- `npm run lint` fails on unsorted imports; `npm run lint:fix` sorts them.
- c8 reports one unreachable branch on `executeQuery`'s `catch`/`finally` line. It is an instrumentation
  artifact - don't chase it.

## Working conventions

- Do not sign commits or pull requests on the assistant's behalf - no `Co-Authored-By: Claude` trailer,
  no "Generated with Claude Code" line.
- Run `git status` before staging. Commit only the files the change is about.
- Every change comes with a test.
- Do not publish a performance number that was not measured. When comparing two versions, alternate
  between them inside one run and take medians - sequential blocks on a loaded machine produce
  differences that are pure ordering artifacts, which has already cost this project's benchmark suite
  once.
- Claims about how another library behaves get checked against that library's own source, not its
  documentation.

## Local setup

PostgreSQL runs on `127.0.0.1:5432` (`postgres`/`postgres`, database `postgres`) from the docker compose
in the PostgreJS repo - that is what `npm test`'s live tests use.

`scripts/run-kysely-suite.sh` runs Kysely's own dialect suite against this dialect: it checks Kysely out,
points its `postgres` variant at us (`scripts/kysely-suite.patch`), and uses Kysely's own compose
database on port 5434, so the local server is untouched. `EXPECTED_FAILURES=3` makes it succeed only
while the known failures are exactly the known failures - the README lists them, and all three are the
suite recognising the `pg` driver rather than a difference in behaviour. Two gotchas: `pnpm`
through corepack dies on Node 24 (`ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`), so the script goes through
`npx --yes pnpm@10.18.3`; and a container left over from a run that could not bind 5434 keeps running
with no published port at all, which the script now recreates rather than wait five minutes for the
suite to time out.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
