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
rewriting - but their types matter. A declared type is one PostgreSQL will not coerce: since 3.9
PostgreJS sends strings and dates unspecified itself (`isUnspecifiedParam`), and the dialect wraps
numbers, booleans, bigints and nulls in `new BindParam(0, value)` for the same reason. Kysely's
suite is what proved the numbers belong there too - a declared `int4` cannot be coalesced with a
`varchar` column, compared against `jsonb`, or assigned into one, and narrowing the wrapping to
`null` alone failed three of its tests.

The cost, measured and accepted: a parameter with neither a type nor a context resolves to `text`,
so `select $1` with a 5 answers `'5'`. There is a live test pinning both sides of that.

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
- Parameter types are left to the server for strings, numbers, booleans, bigints and nulls;
  `inferParameterTypes: false` opts out. Narrowing this was tried and reverted - see above.
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
  `value-shapes.spec.ts` runs the README's "What changes when you switch" table through both this
  dialect and Kysely's `pg` one, so that table is a test rather than a note.
- Code style follows the PostgreJS repo's own `CLAUDE.md`: member order, `protected` over `private`.
- `rman lint` fails on unsorted imports; `rman lint --fix` sorts them. Lint, format, check,
  clean and build are rman commands from `@panates/rman-preset`, not package scripts - see below.
- c8 reports one unreachable branch on `executeQuery`'s `catch`/`finally` line. It is an instrumentation
  artifact - don't chase it.

## Benchmarks

`benchmark/` measures this dialect against Kysely's own `PostgresDialect` over `pg`, through Kysely
on both sides, so the SQL is identical and only the driver differs. `npm run bench` measures and
writes `benchmark/results/latest.json`; `npm run bench:report` renders that file into
`doc/BENCHMARKS.md` and the README's `<!-- bench:… -->` regions, **prose included** - a sentence
makes a claim and goes stale exactly like a number, so no figure is written by hand.

Four rules the harness is built on, each of them a mistake someone already paid for:

- **Memory is three questions**, not one: held between calls, allocated per call, high-water under
  load. They rank the two clients differently. A per-call *peak* is not measurable - the account is
  in `benchmark/heap-worker.mjs`'s header - so what is reported is total allocation over a batch.
- **`heapUsed + external`, never `heapUsed`**, because a `bytea` is a `Buffer`. `--trace-gc` sees
  the JS heap only, so it is stored as a cross-check and never printed.
- **One child process per client** for memory: in a shared process the baseline is taken with both
  already up, so what a client keeps sits under the window rather than in it.
- **Every scenario binds a parameter and reads stored values.** Without a parameter `pg` takes the
  simple protocol and the run compares two protocols; generated values add a server cost both pay,
  which compresses the ratio towards 1.

Do not run anything else on the machine during a run, and do not call a 5-repetition difference a
regression - both have cost a re-measurement next door.

## Build and release

Single-package: the repository *is* the package, which decides most of the rman answers. `.rmanrc.yml`
inherits `@panates/rman-preset` and carries one local key - `group`, `version.cascade` and
`changelog.groupBy` are for repositories with packages to group, and setting them here would change
nothing.

- **Build, lint, format, check and clean are rman commands, not scripts.** The preset's `run.build`
  is `before: [rman check, rman lint, rman clean]`, a tsc exec, and an `after` that copies files,
  writes the build manifest and stamps the version. A leftover `build` script would *win* over that
  exec and a leftover `prebuild` would run alongside the `before` - both silently, so `rman build`'s
  step rows are the check: each step appears once.
- **The one local key is `vars.copyFiles`, and it sits under `"[/]"`.** The preset declares `vars`
  inside `[platform:node]`, and a base's selector block beats a consumer's unmarked key - written
  unmarked, the override was dropped without a word. `rman config --from-root` is what proves it
  landed.
- **`private: true` is gone on purpose.** rman reads that flag on the *source* package and skips it
  before the build directory is involved, so on a single-package repository it means the release
  bumps, tags and cuts a GitHub release while the registry gets nothing. `prepublishOnly` is the
  replacement guard; `rman publish --dry-run` must show a `publish` row, never `skip - private
  package`.
- `CHANGELOG.md` is rman's now, with a `rman:documented-up-to` marker; `rman version` writes the
  entry into the release commit. The preset sets `changelog.unreleased: false`, so a bare
  `rman changelog` prints nothing - pass `--from <tag>`.

## Working conventions

- **No fixups here. A gap in PostgreJS is reported, not worked around.** When something this
  adapter needs is missing, wrong or slower in `postgrejs`, do not patch around it in this package:
  no post-decode value rewriting, no shim, no vendored parser, no `pg`-compatibility table, no
  monkey-patching of the client, no "temporary" branch written to suit the behaviour as it is
  today. Stop there and write the finding up as a task file in `../postgrejs/.claude/<short-name>.md`
  - what was asked of the client, what it answered, what it should answer, and the smallest
  reproduction that shows the difference. That repo's own session picks it up and fixes it at the
  source. Otherwise every adapter ends up carrying its own copy of the same correction, and the
  client's behaviour gets defined by whichever adapter last worked around it. A workaround is
  allowed only when the user is asked for one and says yes; it then carries a comment naming the
  task file it waits on, so it can be removed when the fix lands.
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
database on port 5434, so the local server is untouched. The suite passes outright - 684 on v0.29.6,
the same number Kysely's own `pg` dialect scores on that checkout - so `EXPECTED_FAILURES=0` is what
CI holds it to, and any failure is news. Two gotchas: `pnpm`
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
