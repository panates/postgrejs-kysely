/**
 * Renders the last `npm run bench` into `doc/BENCHMARKS.md` and into the
 * marked regions of `README.md`.
 *
 * The tables and the paragraphs are both generated, and the second half
 * of that is the part worth insisting on: a sentence makes a claim, and a
 * claim goes stale exactly like a number. In the drizzle round six
 * figures in the README and three tables in a document were maintained by
 * hand; one figure inside a sentence stayed at its old value through a
 * version bump, and four sentences were still calling rows losses that
 * had become level.
 *
 * It reads `benchmark/results/latest.json` and runs nothing, so it can be
 * re-run against a measurement taken hours ago.
 *
 *   npm run bench          # measure, and write the results file
 *   npm run bench:report   # render it
 */
import { readFile, writeFile } from 'node:fs/promises';

const RESULTS = new URL('./results/latest.json', import.meta.url);
const DOC = new URL('../doc/BENCHMARKS.md', import.meta.url);
const README = new URL('../README.md', import.meta.url);

const CONTROL = 'node-postgres';
const DRIVER = 'postgrejs';

/** Longest column wins; markdown does not care, but a reader does. */
function table(header, rows) {
  const widths = header.map((cell, i) =>
    Math.max(cell.length, ...rows.map(row => String(row[i]).length)),
  );
  const line = cells =>
    `| ${cells.map((cell, i) => String(cell).padEnd(widths[i])).join(' | ')} |`;
  return [
    line(header),
    `| ${widths.map(w => '-'.repeat(w)).join(' | ')} |`,
    ...rows.map(line),
  ].join('\n');
}

/** Prettier leaves prose as it finds it, so wrap it here. */
function wrap(text, width = 100) {
  const lines = [];
  let line = '';
  for (const word of text.replace(/\s+/g, ' ').trim().split(' ')) {
    if (line && `${line} ${word}`.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

const ms = value => `${value.toFixed(3)} ms`;
/** KB below a megabyte, MB above it - `0.00 MB` says nothing. */
const mb = kb =>
  kb < 1024
    ? `${kb.toFixed(kb < 10 ? 1 : 0)} KB`
    : `${(kb / 1024).toFixed(1)} MB`;
const bold = (text, when) => (when ? `**${text}**` : text);
/**
 * Held memory is the difference between two forced-GC readings, so its
 * resolution runs out around zero, and one scenario's control reads just
 * below its own cold baseline. That is not a negative amount of memory,
 * and printing it as one would be worse than saying what it means.
 */
const held = kb => (kb <= 0 ? '\u2248 0' : mb(kb));

/** What the sign test's split is worth saying about. */
const odds = p => {
  if (p >= 0.05) return 'not distinguishable';
  const exponent = Math.floor(-Math.log10(p));
  return exponent >= 3 ? `< 1 in 10^${exponent}` : `p = ${p.toFixed(3)}`;
};

const pick = (scenario, name) => scenario.rows.find(row => row.name === name);
const speedup = scenario => {
  const [control, driver] = [pick(scenario, CONTROL), pick(scenario, DRIVER)];
  return {
    control,
    driver,
    ratio: control.ms / driver.ms,
    won: scenario.p < 0.05,
    // the memory column gets the same treatment as the clock: a split a
    // coin would produce is printed as level, whichever way the medians
    // happened to fall
    heapRatio: control.allocPerCallKb / driver.allocPerCallKb,
    heapSettled: scenario.heapP < 0.05,
  };
};

/** `**2.65x**`, `1.61x to \`pg\``, or `level` - for the timings. */
function verdict(settled, ratio) {
  if (!settled) return 'level';
  return ratio > 1
    ? `**${ratio.toFixed(2)}x**`
    : `${(1 / ratio).toFixed(2)}x to \`pg\``;
}

/**
 * Memory reads better as a percentage than as a multiple: `-51%` says
 * this dialect allocated half again less than the control did, `+29%`
 * that it allocated more, and the sign carries which way without a
 * phrase for it.
 */
function percent(settled, control, driver) {
  if (!settled) return 'level';
  const change = ((driver - control) / control) * 100;
  const text = `${change > 0 ? '+' : ''}${change.toFixed(0)}%`;
  return change < 0 ? `**${text}**` : text;
}

/**
 * `4.7 MB` when a client keeps it, `4.7 MB -> 755 KB idle` when it hands
 * it back. Only written where the two differ by enough to be a fact
 * about the client rather than about a collection that happened to run.
 */
function heldCell(row) {
  const shown = held(row.heldKb);
  if (row.idleHeldKb == null) return shown;
  const given = row.heldKb - row.idleHeldKb;
  if (given < 512 || given / row.heldKb < 0.25) return shown;
  return `${shown} → ${held(row.idleHeldKb)} idle`;
}

/** What a client holds warm, what a run peaks at, and the wire. */
function memoryTable(results) {
  return table(
    [
      'Scenario',
      `held between calls (${CONTROL} / ${DRIVER})`,
      `high-water under load (${CONTROL} / ${DRIVER})`,
      `off the wire per call (${CONTROL} / ${DRIVER})`,
      `onto the wire per call (${CONTROL} / ${DRIVER})`,
    ],
    results.scenarios.map(scenario => {
      const { control, driver } = speedup(scenario);
      const kb = value =>
        value >= 1024 ? mb(value) : `${value.toFixed(1)} KB`;
      return [
        scenario.name,
        `${heldCell(control)} / ${heldCell(driver)}`,
        `${mb(control.sustainedKb)} / ${mb(driver.sustainedKb)}`,
        `${kb(control.wireKb)} / ${kb(driver.wireKb)}`,
        `${kb(control.wireOutKb)} / ${kb(driver.wireOutKb)}`,
      ];
    }),
  );
}

/**
 * Four columns, two lines to a cell: the time on the first and what one
 * call allocated under it, for each driver, with both verdicts in the
 * last one.
 */
function headlineTable(results, group) {
  const pair = (top, bottom) => `${top}<br>${bottom}`;
  const rows = group
    ? results.scenarios.filter(s => s.group === group)
    : results.scenarios;
  return table(
    [
      'Scenario',
      `${CONTROL}<br>allocated per call`,
      `${DRIVER}<br>allocated per call`,
      '',
    ],
    rows.map(scenario => {
      const { control, driver, ratio, won, heapRatio, heapSettled } =
        speedup(scenario);
      return [
        `${scenario.name} - ${scenario.note}`,
        pair(
          bold(ms(control.ms), won && ratio < 1),
          `${bold(mb(control.allocPerCallKb), heapSettled && heapRatio < 1)}/call`,
        ),
        pair(
          bold(ms(driver.ms), won && ratio > 1),
          `${bold(mb(driver.allocPerCallKb), heapSettled && heapRatio > 1)}/call`,
        ),
        pair(
          verdict(won, ratio),
          percent(heapSettled, control.allocPerCallKb, driver.allocPerCallKb),
        ),
      ];
    }),
  );
}

function signTable(results) {
  return table(
    ['Scenario', 'pairs', `${DRIVER} faster in`, 'odds of that by luck'],
    results.scenarios.map(scenario => [
      scenario.name,
      scenario.pairs,
      scenario.wins,
      odds(scenario.p),
    ]),
  );
}

function heapSignTable(results) {
  return table(
    ['Scenario', 'pairs', `${DRIVER} lower in`, 'odds of that by luck'],
    results.scenarios.map(scenario => [
      scenario.name,
      scenario.heapPairs,
      scenario.heapWins,
      odds(scenario.heapP),
    ]),
  );
}

/** A list, in prose: `a`, `a and b`, `a, b and c`. */
const list = items =>
  items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

/** A figure the prose quotes, so the prose is generated with it. */
function figures(results) {
  const by = name => results.scenarios.find(s => s.name.startsWith(name));
  const array = speedup(by('int4[] of 100k, full width'));
  const bytes = speedup(by('bytea of 4MB'));
  const point = by('point read');
  const builder = by('point read through the builder');
  const tagged = speedup(point);
  const built = speedup(builder);
  // what the builder costs on top of the tag, on each side, as a
  // percentage of the tagged call - both sides compile with Kysely's own
  // compiler, so this is Kysely's own overhead measured twice
  const overhead = (a, b) => `${(((b - a) / a) * 100).toFixed(0)}%`;
  return {
    bytesDriverMs: bytes.driver.ms.toFixed(1),
    bytesControlMs: bytes.control.ms.toFixed(1),
    bytesDriverHeap: mb(bytes.driver.allocPerCallKb),
    bytesControlHeap: mb(bytes.control.allocPerCallKb),
    bytesRatio: bytes.ratio.toFixed(1),
    arrayRatio: array.ratio.toFixed(1),
    arrayDriverMs: array.driver.ms.toFixed(1),
    arrayControlMs: array.control.ms.toFixed(1),
    arrayDriverHeap: mb(array.driver.allocPerCallKb),
    arrayControlHeap: mb(array.control.allocPerCallKb),
    pointWins: point.wins,
    pointPairs: point.pairs,
    pointRatio: tagged.ratio.toFixed(2),
    pointDriverMs: tagged.driver.ms.toFixed(3),
    pointControlMs: tagged.control.ms.toFixed(3),
    builderWins: builder.wins,
    builderPairs: builder.pairs,
    builderRatio: built.ratio.toFixed(2),
    builderCostDriver: overhead(tagged.driver.ms, built.driver.ms),
    builderCostControl: overhead(tagged.control.ms, built.control.ms),
    builderDriverMs: built.driver.ms.toFixed(3),
    builderControlMs: built.control.ms.toFixed(3),
    builderAllocDriver: (
      built.driver.allocPerCallKb - tagged.driver.allocPerCallKb
    ).toFixed(1),
    builderAllocControl: (
      built.control.allocPerCallKb - tagged.control.allocPerCallKb
    ).toFixed(1),
    // the two are separate scenarios rather than a pair, so their
    // medians are only worth comparing when the spreads do not overlap
    builderTimeSeparates:
      built.driver.lo > tagged.driver.hi || built.driver.hi < tagged.driver.lo,
  };
}

/**
 * The paragraphs that say what the tables mean. Generated, because every
 * claim in here is one the next run can overturn: a row that is level
 * today becomes a win when something upstream is fixed, and a
 * hand-written sentence would still be calling it level.
 */
function reading(results) {
  const named = results.scenarios.map(s => ({ ...s, ...speedup(s) }));
  const reads = named.filter(s => s.group === 'Read');
  const writes = named.filter(s => s.group === 'Write');
  // grouped by what the memory column says rather than by the clock: a
  // row where this dialect allocates a fifth of what `pg` does is a
  // payload row whatever its time ratio
  const payload = reads.filter(s => s.heapSettled && s.heapRatio >= 1.2);
  const ordinary = reads.filter(s => !(s.heapSettled && s.heapRatio >= 1.2));
  const short = name => `\`${name.split(' - ')[0]}\``;
  const spread = named.find(s => s.name === 'float8 of 5k rows, full width');
  const packed = named.find(s => s.name === 'float8[] of 5k in one row');
  const arrayWrite = writes.find(s => s.name.includes('int4[]'));
  const grown = [...named].sort(
    (a, b) =>
      b.driver.heldKb - b.control.heldKb - (a.driver.heldKb - a.control.heldKb),
  )[0];
  const says = s =>
    !s.won
      ? 'level'
      : s.ratio > 1
        ? `${s.ratio.toFixed(2)}x`
        : `${(1 / s.ratio).toFixed(2)}x to \`pg\``;

  const paragraphs = [
    payload.length &&
      `**Large payloads are where it wins, and it wins them by a lot.** ${list(
        payload.map(
          s =>
            `${short(s.name)} ${says(s)} on ${mb(s.driver.allocPerCallKb)} against ${mb(s.control.allocPerCallKb)}`,
        ),
      )}. Those columns arrive in PostgreSQL's binary format and are decoded per type, where \`pg\`
       asks for text and parses it - and the parse is most of what that saves, because the text path
       has to materialise the whole value as a string first.`,

    spread &&
      packed &&
      `**What decides it is values per row, not values.** ${short(spread.name)} and
       ${short(packed.name)} hold the same 5000 \`float8\`s and differ in nothing but shape. Spread
       over 5000 rows it is ${mb(spread.driver.allocPerCallKb)} against
       ${mb(spread.control.allocPerCallKb)}, because the protocol's per-row cost is most of what
       either client pays. Packed into one row it is ${mb(packed.driver.allocPerCallKb)} against
       ${mb(packed.control.allocPerCallKb)} - and it is \`pg\` getting worse rather than this dialect
       getting better, because one row of 5000 values is a megabyte of array literal with a
       substring cut per element. Two workloads that both look like "a lot of numbers" disagree by
       more than tenfold, and only the pair explains why.`,

    ordinary.length &&
      `**Everything else gains on the clock and not on memory.** ${list(
        ordinary.map(s => `${short(s.name)} ${says(s)}`),
      )} - and on memory those rows are level or a few percent the wrong way. A result of many
       narrow rows is mostly round trips and per-row protocol cost, which is the same work on both
       sides.`,

    writes.length &&
      `**Writing moves less, because the server does the work.** ${list(
        writes.map(s => `${short(s.name)} ${says(s)}`),
      )}.${
        arrayWrite
          ? ` The one that moves on memory is ${short(arrayWrite.name)}, at
       ${mb(arrayWrite.driver.allocPerCallKb)} against ${mb(arrayWrite.control.allocPerCallKb)}:
       \`pg\` builds the array literal as a string in the JS heap, while PostgreJS writes the
       integers into the send buffer from the numbers themselves.`
          : ''
      }`,

    grown &&
      `**Memory held is small on both, with one exception.** Between calls the two sit within a few
       hundred KB of each other everywhere but ${short(grown.name)}, where PostgreJS holds
       ${held(grown.driver.heldKb)} against ${held(grown.control.heldKb)} - one send buffer per
       connection, grown to the largest message it has written and handed back after five seconds
       of quiet. Waited out, the same process holds ${held(grown.driver.idleHeldKb)}. \`pg\` builds
       a fresh buffer per message and drops it, so it has nothing to hand back and reads the same
       either way. A held figure is the difference between two forced-GC readings, so \u2248 0 is
       what its resolution has to say about a client that is holding nothing in particular.`,

    `**Where it reaches you.** Through Kysely the wins are \`bytea\` columns, array columns, and any
     single row that carries a lot of values. A schema of text, integers and timestamps sees the
     ordinary rows and not the payload ones - a little faster, and about the same memory.`,
  ].filter(Boolean);

  return paragraphs.map(paragraph => wrap(paragraph)).join('\n\n');
}

function document(results) {
  const { versions, clientConfig } = results;
  const f = figures(results);
  return `# The same Kysely calls, on both dialects

_Generated by \`npm run bench:report\` from the last \`npm run bench\`. Do not hand-edit - re-run the
command instead._

What this dialect costs or saves against Kysely's own \`PostgresDialect\` over \`pg\` - the numbers a
caller of the query builder or a \`sql\` tag actually sees.

\`\`\`sh
npm run bench          # measure
npm run bench:report   # render this file and the README's tables
\`\`\`

## What is being compared

${wrap(`Both sides are Kysely. The adapter, the introspector, the query compiler and the plugins are
Kysely's own code in either case - only \`Driver\` and \`DatabaseConnection\` differ - so the SQL is
identical by construction and what is left between the caller and the wire is the driver. That makes
this the cleanest of the postgrejs adapters to measure through: there is no ORM mapping layer above
it paying a cost on both sides and compressing the ratio towards 1.`)}

${wrap(`The dialect runs on its defaults, which is a choice worth stating: no \`fetchAsString\`, so
\`int8\` arrives as PostgreJS decodes it rather than as \`pg\`'s string. Asking the server for text on
a type changes both what crosses the socket and what gets decoded, so it would be a different
measurement; \`dialectConfig\` in the results file records which one this was.`)}

${wrap(
  clientConfig?.asyncErrorHandling === false
    ? `One client setting is not a default: the PostgreJS pool is opened with
\`asyncErrorHandling: false\`. On, it captures a stack so a rejected query points at the line that
called it rather than at a frame inside the client, and capturing costs CPU. \`pg\` offers nothing
of the kind, so leaving it on would bill one side for a feature the comparison does not cover. It
is not off because it changes the answer - measured in the drizzle round it is worth about 3% on
the one scenario with several calls in flight at once, and nothing anywhere else. The results file
records it as \`clientConfig\`.`
    : `The PostgreJS pool is opened on the client's own defaults, \`asyncErrorHandling\` included -
which is worth knowing, because that one captures a stack per call and \`pg\` has no equivalent to
pay for.`,
)}

## Method

${wrap(`Every scenario runs through both drivers against the same server, alternating them inside each
pair and swapping which goes first, so a cold cache or a busy moment lands on both equally. The
medians are what the tables print; the sign test beside them counts only **which** driver won each
pair, which is what survives a shared machine.`)}

${wrap(`**Two numbers per row.** The time is one call. The memory is what one call **asks for** -
everything allocated while it runs, whether or not any of it survives - measured in a process of its
own per driver, so a client's own buffers are inside the window rather than under it. A call is one
\`sql\` tag execution, one builder execution, or one transaction; where that is more than one
statement the scenario's note says so.`)}

${wrap(`Memory has more than one honest answer, so the table below the results carries three: what a
client keeps between calls, what a call allocates, and how high the process goes before the runtime
collects. They rank the two differently and are meant to - the last one is partly a fact about the
application around the client. \`benchmark/heap-worker.mjs\` has the rest, including the account of
why a per-call peak is not measurable.`)}

## Results

${wrap(`Node ${versions.node}, \`postgrejs\` ${versions.postgrejs}, \`pg\` ${versions.pg}, \`kysely\` ${versions.kysely}, PostgreSQL on loopback, medians per call.`)}

### Reading

${headlineTable(results, 'Read')}

### Writing

${headlineTable(results, 'Write')}

And which driver actually won, pair by pair:

${signTable(results)}

${wrap(`That is a sign test: only which driver won counts, and by how much is thrown away, which is
exactly what makes it survive a noisy machine. Two clients of equal speed would split the pairs
evenly, so the last column is the probability of seeing a split that lopsided from a fair coin. It
says which differences are real; it says nothing about their size, which is what the ratio column is
for. A split a coin would produce is printed as level rather than rounded into a win.`)}

The memory line of the last column is a percentage rather than a multiple, and it is \`postgrejs\`
against \`node-postgres\`: \`-51%\` is half again less allocated, \`+29%\` is more.

${heapSignTable(results)}

${wrap(`Memory is counted the same way and for the same reason - one child process per driver, so what
a client allocates once and keeps is inside the window rather than under it, and the JS heap and the
off-heap buffers are sampled together as one number. That last part matters more than it sounds: a
\`bytea\` arrives as a \`Buffer\`, which lives outside the JS heap entirely, so \`heapUsed\` alone would
read the 4 MB column as a few hundred KB.`)}

${memoryTable(results)}

${wrap(`The first two columns are properties of the client. The third is partly a property of the
application around it - with a larger live heap under the same calls the collections halve and the
ceiling floats higher, so two clients can change places on it without either behaving differently.
Take the allocation column as the comparison and the high-water as sizing.`)}

## Reading them

${reading(results)}

## What the query builder costs

${wrap(`Two scenarios read the same row, one through a \`sql\` tag and one through
\`selectFrom().where()\`, so what the builder costs is measured rather than assumed. On the clock it
does not separate: ${f.pointDriverMs} ms against ${f.builderDriverMs} ms here and
${f.pointControlMs} ms against ${f.builderControlMs} ms on \`pg\`, inside spreads that overlap - and
the two are separate scenarios rather than a pair, so that difference is drift and not a
measurement. On allocation it does: the builder costs ${f.builderAllocDriver} KB a call more here
and ${f.builderAllocControl} KB more on \`pg\`, from tight spreads on both sides. Nearly the same
number twice, which is what it should be - both sides compile with Kysely's own
\`PostgresQueryCompiler\`, so this is Kysely's own overhead paid once per driver and not a
difference between them. The comparison carries over unchanged: ${f.pointRatio}x through the tag,
${f.builderRatio}x through the builder.`)}

## Both sides speak the same protocol

${wrap(`\`pg\` sends a query with no values over PostgreSQL's **simple** protocol -
\`requiresPreparation()\` in \`pg/lib/query.js\` returns false without a name, a row limit or values,
and Kysely gives it neither a name nor a row limit - while PostgreJS's \`query()\` always speaks the
extended one. A scenario that read a stored value and bound nothing would therefore be comparing two
protocols rather than two clients, which is not a small difference: in the drizzle round, on a 1 KB
\`bytea\`, it accounted for almost the whole memory gap between the two.`)}

${wrap(`So every scenario here binds at least one parameter - usually a \`limit\` that selects the whole
result, there to even the comparison rather than to filter anything. What is left is a difference
between the clients on one protocol: \`pg\` binds an unnamed statement, which the server parses again
on every call, while PostgreJS names and caches one per connection and reuses it.`)}

## Where this sits among the others

${wrap(`The client underneath has its own benchmark against \`pg\` and \`postgres.js\`, on more scenarios
than this - COPY, cursors, pooling, pipelining - in
[\`postgrejs/doc/BENCHMARKS.md\`](https://github.com/panates/postgrejs/blob/master/doc/BENCHMARKS.md).
It measures the client; this measures the client through Kysely, so the two are not interchangeable
and the numbers should not be read across. The same suite pointed through drizzle is in
[\`drizzle-postgrejs\`](https://github.com/panates/postgrejs-drizzle/blob/master/doc/BENCHMARKS.md),
where an ORM mapping layer sits above the driver on both sides; a gain that shows there and not here
is being paid for somewhere other than the client.`)}
`;
}

/** Rewrites one `<!-- bench:name -->` … `<!-- /bench:name -->` region. */
function replaceRegion(text, name, body) {
  const open = `<!-- bench:${name} -->`;
  const close = `<!-- /bench:${name} -->`;
  const from = text.indexOf(open);
  const to = text.indexOf(close);
  if (from === -1 || to === -1)
    throw new Error(`README.md has no ${open} … ${close} region`);
  return `${text.slice(0, from + open.length)}\n\n${body}\n\n${text.slice(to)}`;
}

const results = JSON.parse(await readFile(RESULTS, 'utf8'));
const f = figures(results);
const { versions } = results;

await writeFile(DOC, document(results));

let readme = await readFile(README, 'utf8');
readme = replaceRegion(
  readme,
  'intro',
  wrap(`It is faster where it counts, and it allocates far less doing it. A 4 MB \`bytea\` comes back in
${f.bytesDriverMs} ms against ${f.bytesControlMs} ms, on ${f.bytesDriverHeap} a call against
${f.bytesControlHeap} - \`pg\` reads that column as hex text, twice the size, off the JS heap where a
heap figure alone cannot see it. A 100k-element \`int4[]\` runs ${f.arrayRatio}x, on
${f.arrayDriverHeap} against ${f.arrayControlHeap}. Ordinary queries gain less and gain it
repeatably: a point read is the faster of the two in ${f.pointWins} of ${f.pointPairs} alternated
pairs. All of it measured through Kysely against Kysely's own \`PostgresDialect\` over \`pg\`, on the
same server: [\`doc/BENCHMARKS.md\`](doc/BENCHMARKS.md).`),
);
readme = replaceRegion(
  readme,
  'payload',
  wrap(
    `- **Faster where the payload is large** - ${f.bytesRatio}x on a 4 MB \`bytea\` and ${f.arrayRatio}x on a 100k-element \`int4[]\`, on a fraction of the memory, because the values arrive in PostgreSQL's binary format rather than as text to be parsed.`,
    98,
  ).replace(/\n/g, '\n  '),
);
readme = replaceRegion(
  readme,
  'headline',
  `${headlineTable(results)}

` +
    wrap(
      `\`kysely\` ${versions.kysely}, \`postgrejs\` ${versions.postgrejs}, \`pg\` ${versions.pg}, PostgreSQL on loopback, Node ${versions.node.replace('v', '')}. Medians; how that was measured and how much each row can bear are in [How the numbers were measured](#how-the-numbers-were-measured).`,
    ),
);
readme = replaceRegion(readme, 'signtest', signTable(results));
readme = replaceRegion(
  readme,
  'binary',
  wrap(`Result columns arrive in PostgreSQL's binary format and are decoded per type, where \`pg\` asks
for text and parses it. On bulk that is the whole difference: a 100k-element \`int4[]\` costs
${f.arrayDriverMs} ms and ${f.arrayDriverHeap} here against ${f.arrayControlMs} ms and
${f.arrayControlHeap}, because the text path has to materialise the array literal as one string
before it can parse it.`),
);
readme = replaceRegion(
  readme,
  'prepared',
  wrap(`PostgreJS names and caches a statement per connection - 64 by default, least-recently-used
closed - so each distinct SQL string is parsed and planned once rather than on every call. \`pg\`
prepares only a query it was given a name for, and Kysely does not give it one, so the same
statement is parsed again on every call there. That is what the point read's ${f.pointWins} pairs of
${f.pointPairs} is made of.`),
);
readme = replaceRegion(
  readme,
  'builder',
  wrap(`The query builder itself costs ${f.builderAllocDriver} KB a call over a \`sql\` tag here and
${f.builderAllocControl} KB on \`pg\`, and nothing that separates from drift on the clock - Kysely's
own compiler runs on both sides, so it is the same work paid once per driver rather than a
difference between them. The same read is ${f.pointRatio}x through the tag and ${f.builderRatio}x
through the builder.`),
);
await writeFile(README, readme);

console.log(
  `doc/BENCHMARKS.md and README.md rendered from a run of ${results.measuredAt}`,
);
