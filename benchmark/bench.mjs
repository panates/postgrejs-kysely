/**
 * The same Kysely calls through this dialect and through Kysely's own
 * `PostgresDialect` over `pg`, on one server, in one process.
 *
 * The two are alternated inside every pair and the order is swapped each
 * time, so an ordering artifact - a cold cache, a busy moment on the
 * machine - lands on both equally. What is reported is the median across
 * pairs, never a single run, and beside it a sign test on which side won
 * each pair, which is what survives a machine whose absolute numbers
 * drift. Memory is measured in a child process per driver, because it
 * cannot be measured in a shared one at all.
 *
 *   node --expose-gc benchmark/bench.mjs
 *   node --expose-gc benchmark/bench.mjs --pairs=7 --heap-pairs=3 --scenario=page
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { Pool as PgPool } from 'pg';
import {
  CLIENT_CONFIG,
  CONN,
  CONTROL,
  DDL,
  describeScenarios,
  DIALECT_CONFIG,
  DRIVER,
  openDatabases,
  scenariosMatching,
  SCHEMA,
} from './scenarios.mjs';

const run = promisify(execFile);
const HEAP_WORKER = new URL('./heap-worker.mjs', import.meta.url).pathname;
const RESULTS_FILE = new URL('./results/latest.json', import.meta.url);

const arg = (name, fallback) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const PAIRS = Number(arg('pairs', 0)); // 0: each scenario's own
const HEAP_PAIRS = Number(arg('heap-pairs', 15));
const ONLY = arg('scenario', 'all');

/**
 * One timed batch. Nothing is sampled while it runs: polling
 * `process.memoryUsage()` inside the timed window costs more than the
 * calls being timed and lands unevenly on the two drivers - in the
 * drizzle round that alone reported a 2x that was its own instrument.
 */
async function timedBatch(scenario, db) {
  // outside the clock on purpose: emptying the target is not the work
  if (scenario.setup) await scenario.setup(db);
  const started = performance.now();
  for (let i = 0; i < scenario.iters; i++) await scenario.run(db, i);
  return (performance.now() - started) / scenario.iters;
}

/** What one call allocates, measured in a process of its own. */
async function memoryInChild(scenario, driver) {
  const { stdout } = await run(
    process.execPath,
    ['--expose-gc', '--trace-gc', HEAP_WORKER, driver, scenario.name],
    { env: process.env, maxBuffer: 64 * 1024 * 1024 },
  );
  const measured = JSON.parse(
    stdout.split('\n').find(line => line.startsWith('{')),
  );
  return { ...measured, reclaimedKb: reclaimedBetweenMarks(stdout) };
}

/**
 * What the same client still holds once the calls stop. One run per
 * driver per scenario rather than one per pair: it is a wall-clock wait,
 * and unlike the allocation figure it does not move between pairs.
 */
async function idleHeapInChild(scenario, driver) {
  const { stdout } = await run(
    process.execPath,
    ['--expose-gc', HEAP_WORKER, driver, scenario.name, 'idle'],
    { env: process.env },
  );
  const { idleHeldKb } = JSON.parse(stdout);
  return idleHeldKb;
}

/**
 * What every collection handed back while the measured calls were
 * running, added up, from `--trace-gc`'s `before (capacity) -> after
 * (capacity) MB`. It agrees with the sampled estimator on ordinary rows
 * and diverges completely wherever a `Buffer` is involved, because it
 * sees the JS heap only - so it is written into the results file as a
 * cross-check and never printed as a column.
 */
function reclaimedBetweenMarks(stdout) {
  const mark = Number(/MARK (\d+)/.exec(stdout)?.[1]);
  const end = Number(/END (\d+)/.exec(stdout)?.[1]);
  if (!Number.isFinite(mark) || !Number.isFinite(end)) return 0;
  const line =
    /^\[\d+:0x[0-9a-f]+\]\s+(\d+) ms: \S+.*?([\d.]+) \([\d.]+\) -> ([\d.]+) \(/;
  let total = 0;
  for (const text of stdout.split('\n')) {
    const found = line.exec(text);
    if (!found) continue;
    const at = Number(found[1]);
    if (at >= mark && at <= end) total += Number(found[2]) - Number(found[3]);
  }
  return total * 1024;
}

const median = xs => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Two-sided probability of a split at least this lopsided from a fair
 * coin. Only which driver won each pair counts, and by how much is
 * thrown away - which is exactly what lets it survive a machine whose
 * absolute numbers drift between runs.
 */
function signTest(wins, n) {
  const logFactorial = [0];
  for (let i = 1; i <= n; i++)
    logFactorial[i] = logFactorial[i - 1] + Math.log(i);
  const logChoose = k =>
    logFactorial[n] - logFactorial[k] - logFactorial[n - k];
  const extreme = Math.min(wins, n - wins);
  let tail = 0;
  for (let k = 0; k <= extreme; k++)
    tail += Math.exp(logChoose(k) - n * Math.LN2);
  return Math.min(1, 2 * tail);
}

/** '< 1 in 10^12', or 'not distinguishable' when the split says nothing. */
function odds(p) {
  if (p >= 0.05) return 'not distinguishable';
  const exponent = Math.floor(-Math.log10(p));
  return exponent >= 3 ? `< 1 in 10^${exponent}` : `p = ${p.toFixed(3)}`;
}

async function main() {
  const { dbs, close } = openDatabases(false);
  const { dbs: pooled, close: closePooled } = openDatabases(true);
  const dbFor = (scenario, name) =>
    scenario.pooled ? pooled[name] : dbs[name];

  const pgPool = new PgPool({ ...CONN, max: 1 });
  for (const statement of DDL) await pgPool.query(statement);

  const scenarios = scenariosMatching(ONLY);
  const names = [CONTROL, DRIVER];
  const results = [];

  // what is about to be measured, in the SQL each scenario really sends -
  // shortened, because one of them carries 2500 placeholders and another
  // 100000 parameters
  const shorten = (text, limit = 150) => {
    const oneLine = text.replace(/\s+/g, ' ').trim();
    return oneLine.length > limit
      ? `${oneLine.slice(0, limit)} … (${oneLine.length} chars)`
      : oneLine;
  };
  const describeParams = params => {
    if (!params.length) return '';
    const shown = params
      .slice(0, 4)
      .map(p =>
        Array.isArray(p)
          ? `array[${p.length}]`
          : Buffer.isBuffer(p)
            ? `buffer[${p.length}]`
            : JSON.stringify(p),
      )
      .join(', ');
    return `${params.length} param${params.length > 1 ? 's' : ''}: ${shown}${params.length > 4 ? ', …' : ''}`;
  };

  console.log('\nscenarios');
  let group;
  for (const { scenario, query, params, calls } of await describeScenarios(
    scenarios,
  )) {
    if (scenario.group !== group) {
      group = scenario.group;
      console.log(`\n  ${group ?? 'Other'}`);
    }
    console.log(`\n    ${scenario.name} - ${scenario.note}`);
    console.log(
      `      ${scenario.iters} calls per timed unit, ${scenario.pairs} pairs` +
        (calls > 1 ? `, ${calls} statements a call` : ''),
    );
    console.log(`      ${shorten(query)}`);
    const described = describeParams(params);
    if (described) console.log(`      ${described}`);
  }

  /**
   * One scenario's worth of work before anything is recorded, thrown
   * away. Each scenario already warms itself, but the *first* scenario
   * of a run also pays for whatever the machine was doing a moment ago:
   * measured, a point read that reads 0.303 ms against 0.267 in a
   * settled run came out at 0.632 against 0.574 as the opening scenario,
   * while the identical read one scenario later was 0.283 against 0.248.
   * Both clients slowed by the same factor, so the ratio and the winner
   * survived it - but the absolute figures in that row did not, and a
   * table cannot print a row that its own next row contradicts.
   */
  const settle = scenarios[0];
  for (let round = 0; round < 3; round++)
    for (const name of names) await timedBatch(settle, dbFor(settle, name));

  for (const scenario of scenarios) {
    const pairs = PAIRS || scenario.pairs;
    for (const name of names) {
      if (scenario.setup) await scenario.setup(dbFor(scenario, name));
      for (let i = 0; i < Math.min(scenario.iters * 4, 60); i++)
        await scenario.run(dbFor(scenario, name), i);
    }
    const samples = { [names[0]]: [], [names[1]]: [] };
    let wins = 0;
    for (let pair = 0; pair < pairs; pair++) {
      // swap the order every pair, so neither driver always runs first
      const order = pair % 2 ? [names[1], names[0]] : names;
      const timed = {};
      for (const name of order)
        timed[name] = await timedBatch(scenario, dbFor(scenario, name));
      for (const name of names) samples[name].push(timed[name]);
      if (timed[names[1]] < timed[names[0]]) wins++;
    }

    // and the memory, one child process per driver per pair
    const held = { [names[0]]: [], [names[1]]: [] };
    const alloc = { [names[0]]: [], [names[1]]: [] };
    const sustained = { [names[0]]: [], [names[1]]: [] };
    const sustainedRss = { [names[0]]: [], [names[1]]: [] };
    const reclaimed = { [names[0]]: [], [names[1]]: [] };
    const wire = { [names[0]]: [], [names[1]]: [] };
    const wireOut = { [names[0]]: [], [names[1]]: [] };
    let memoryCalls = 0;
    let allocWins = 0;
    let sustainedWins = 0;
    for (let pair = 0; pair < HEAP_PAIRS; pair++) {
      const order = pair % 2 ? [names[1], names[0]] : names;
      const measured = {};
      for (const name of order)
        measured[name] = await memoryInChild(scenario, name);
      for (const name of names) {
        held[name].push(measured[name].heldKb);
        alloc[name].push(measured[name].allocPerCallKb);
        sustained[name].push(measured[name].sustainedKb);
        sustainedRss[name].push(measured[name].sustainedRssKb);
        reclaimed[name].push(
          measured[name].reclaimedKb / measured[name].iterations,
        );
        wire[name].push(measured[name].wireKb);
        wireOut[name].push(measured[name].wireOutKb);
        memoryCalls = measured[name].iterations;
      }
      // counted on what a call allocates, because that is the column the
      // report leads with - the high-water is counted separately, since
      // the two rank the drivers differently on purpose
      if (measured[names[1]].allocPerCallKb < measured[names[0]].allocPerCallKb)
        allocWins++;
      if (measured[names[1]].sustainedKb < measured[names[0]].sustainedKb)
        sustainedWins++;
    }

    const idleHeld = {};
    for (const name of names)
      idleHeld[name] = await idleHeapInChild(scenario, name);

    results.push({
      scenario,
      pairs,
      wins,
      p: signTest(wins, pairs),
      heapPairs: HEAP_PAIRS,
      memoryCalls,
      sustainedWins,
      heapWins: allocWins,
      heapP: signTest(allocWins, HEAP_PAIRS),
      rows: names.map(name => ({
        name,
        ms: median(samples[name]),
        lo: Math.min(...samples[name]),
        hi: Math.max(...samples[name]),
        allocPerCallKb: median(alloc[name]),
        allocLoKb: Math.min(...alloc[name]),
        allocHiKb: Math.max(...alloc[name]),
        heldKb: median(held[name]),
        idleHeldKb: idleHeld[name],
        sustainedKb: median(sustained[name]),
        sustainedRssKb: median(sustainedRss[name]),
        reclaimedKb: median(reclaimed[name]),
        wireKb: median(wire[name]),
        wireOutKb: median(wireOut[name]),
      })),
    });
  }

  await close();
  await closePooled();

  await pgPool.query(`drop schema ${SCHEMA} cascade`);
  await pgPool.end();

  // read off disk rather than imported: a package's `exports` map need
  // not expose its own package.json, and an import of it then throws
  const versionOf = async name =>
    JSON.parse(
      await readFile(
        new URL(`../node_modules/${name}/package.json`, import.meta.url),
        'utf8',
      ),
    ).version;
  const versions = {
    node: process.version,
    postgrejs: await versionOf('postgrejs'),
    pg: await versionOf('pg'),
    kysely: await versionOf('kysely'),
  };

  // the run's own record, so `npm run bench:report` can render it without
  // running anything - and so nothing has to be copied by hand
  await mkdir(new URL('.', RESULTS_FILE), { recursive: true });
  await writeFile(
    RESULTS_FILE,
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        versions,
        // which configuration was measured, since `fetchAsString` would
        // change what crosses the socket and what gets decoded, and
        // `asyncErrorHandling` bills one client for a feature the other
        // does not have - written into the record so the report can state
        // them from the run rather than from a sentence someone has to
        // remember to update
        dialectConfig: DIALECT_CONFIG,
        clientConfig: CLIENT_CONFIG,
        scenarios: results.map(
          ({
            scenario,
            pairs,
            wins,
            p,
            heapPairs,
            memoryCalls,
            heapWins,
            heapP,
            sustainedWins,
            rows,
          }) => ({
            name: scenario.name,
            note: scenario.note,
            group: scenario.group,
            iters: scenario.iters,
            pairs,
            wins,
            p,
            heapPairs,
            memoryCalls,
            heapWins,
            heapP,
            sustainedWins,
            rows,
          }),
        ),
      },
      null,
      2,
    ) + '\n',
  );

  console.log(
    `\nmedian per call, drivers alternated within every pair, order swapped each pair`,
  );
  console.log(
    `node ${versions.node}, postgrejs ${versions.postgrejs}, pg ${versions.pg}, kysely ${versions.kysely}\n`,
  );
  for (const {
    scenario,
    rows,
    pairs,
    wins,
    p,
    heapPairs,
    heapWins,
    heapP,
  } of results) {
    console.log(
      `${scenario.name} - ${scenario.note} (${scenario.iters} calls per timed unit, ${pairs} pairs)`,
    );
    const slowest = Math.max(...rows.map(r => r.ms));
    for (const r of rows)
      console.log(
        `  ${r.name.padEnd(15)} ${r.ms.toFixed(3).padStart(9)} ms/op  ` +
          `${(slowest / r.ms).toFixed(2)}x  ` +
          `spread ${r.lo.toFixed(3)}-${r.hi.toFixed(3)}  ` +
          `${r.allocPerCallKb.toFixed(1).padStart(6)} KB/call ` +
          `(${r.allocLoKb.toFixed(1)}-${r.allocHiKb.toFixed(1)}), ` +
          `holds ${(r.heldKb / 1024).toFixed(1)} MB, ` +
          `wire ${r.wireKb.toFixed(1)} in / ${r.wireOutKb.toFixed(1)} out KB`,
      );
    console.log(`  -> postgrejs won ${wins} of ${pairs} pairs, ${odds(p)}`);
    console.log(
      `     allocation: postgrejs lower in ${heapWins} of ${heapPairs}, ${odds(heapP)}`,
    );
    console.log();
  }
  console.log(
    'written to benchmark/results/latest.json - `npm run bench:report` renders it\n',
  );
}

await main();
