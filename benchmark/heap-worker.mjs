/**
 * One driver, one scenario, one process - and nothing else in it.
 *
 * Memory cannot be measured with both clients alive in one process: the
 * baseline would be taken after both are up, so their pools, buffers and
 * decoders sit under it rather than in it, and what a client allocates
 * once and keeps is invisible by construction. A child per driver is
 * also how PostgreJS's own suite measures.
 *
 *   node --expose-gc benchmark/heap-worker.mjs <driver> <scenario> [idle]
 *
 * With `idle` it measures only what the client keeps: once with the calls
 * still coming, and once after long enough that a client which caches a
 * buffer between calls has had time to hand it back. That second reading
 * costs a wall-clock wait, so it is a pass of its own rather than part of
 * every one.
 *
 * It prints one JSON line and exits.
 *
 * ## Why there is no per-call peak here
 *
 * There was one in the drizzle round, and it was given up on after
 * failing three mutually exclusive ways - which is what makes the
 * quantity unmeasurable rather than merely hard:
 *
 * - **Sampled, it mostly sampled nothing.** A timer cannot fire faster
 *   than once a millisecond, so a call that returns in 0.6 ms took zero
 *   samples in five rounds of five and the column printed 0 KB for a call
 *   that allocates about 30. A slightly longer one took zero or one and
 *   printed 282 KB against 41 - an `-85%` verdict that was two coin
 *   flips, where the measured figures are 398 KB against 298.
 * - **Sampled over a longer call it understated unevenly.** On a 4 MB
 *   `bytea` read it caught 24.7 MB of `pg`'s 53.5 while catching 8.2 of
 *   PostgreJS's 8.4 - one side read 2.2x low, the other 1.03x. That moves
 *   the comparison, not just the figure.
 * - **Read exactly at the end of the call, the baseline is wrong.** The
 *   first call after a forced collection is not like the ones after it,
 *   and by a different factor per client. Spending calls to settle that
 *   fixes the short rows and ruins the large ones.
 *
 * What replaced it is below: total allocation over a batch, which does
 * not care where a collection lands.
 */
import net from 'node:net';

// Bytes the server actually sent, counted at the socket rather than taken
// from either client's own accounting - the same instrument PostgreJS's
// suite uses, and the reason this is measured at all: in the drizzle
// round the wire cost of the binary format for an int4[] of small numbers
// was argued from the encoding source until it was counted, and the
// argument had it backwards.
let received = 0;
let sent = 0;
const push = net.Socket.prototype.push;
net.Socket.prototype.push = function (chunk, ...rest) {
  if (chunk) received += chunk.length;
  return push.call(this, chunk, ...rest);
};
// and what goes out, which a write scenario is entirely made of - the
// received column reads next to nothing for every one of them
const write = net.Socket.prototype.write;
net.Socket.prototype.write = function (chunk, ...rest) {
  if (chunk) sent += chunk.length ?? Buffer.byteLength(chunk);
  return write.call(this, chunk, ...rest);
};

// imported before the baseline on purpose, so both clients' module graphs
// are under it and only the one being measured grows inside the window
const { CONTROL, DRIVER, openDatabases, scenariosMatching } =
  await import('./scenarios.mjs');

const usedBytes = () => {
  const usage = process.memoryUsage();
  // never `heapUsed` alone: a Buffer is external, and the whole argument
  // this measures is about bytes off a socket
  return usage.heapUsed + usage.external;
};

// Taken before a pool exists, so what the client grows by can be told
// apart from what Node and Kysely were already holding.
globalThis.gc();
globalThis.gc();
const cold = usedBytes();

const [which, name, mode] = process.argv.slice(2);
const scenario = scenariosMatching('all').find(s => s.name === name);
if (!scenario) throw new Error(`no scenario named ${name}`);
if (which !== CONTROL && which !== DRIVER)
  throw new Error(`no driver named ${which}`);

const { dbs, close } = openDatabases(scenario.pooled);
const db = dbs[which];

// Warm up first: the JIT, the pool's connections and - on this driver -
// the prepared statement each distinct SQL earns. What is measured is a
// scenario in its steady state, not its first call.
if (scenario.setup) await scenario.setup(db);
const warmup = Math.min(scenario.iters * 4, 60);
for (let i = 0; i < warmup; i++) await scenario.run(db, i);
if (scenario.setup) await scenario.setup(db);

globalThis.gc();
globalThis.gc();
// What the client holds at rest, warm: its pool, its buffers, its
// prepared statements. Separate from what a call costs and from what a
// run peaks at - three different questions.
const atRest = usedBytes();

/**
 * The same question asked again after a pause, because one of these
 * clients answers it differently depending on when you ask.
 *
 * PostgreJS writes each message into one growing buffer per connection
 * and reclaims it after `houseKeepMs` (5s) of quiet, so a client that
 * just sent a 4 MB parameter is still holding the 4 MB it grew to. That
 * is real while the calls keep coming and gone shortly after they stop,
 * and a single figure cannot say both. `pg` builds a fresh buffer per
 * message and drops it, so it has nothing to give back and reads the
 * same either way - which is what makes the gap look like a leak until
 * you wait.
 */
if (mode === 'idle') {
  await new Promise(resolve => setTimeout(resolve, 6000));
  globalThis.gc();
  globalThis.gc();
  console.log(
    JSON.stringify({
      driver: which,
      scenario: name,
      heldKb: (atRest - cold) / 1024,
      idleHeldKb: (usedBytes() - cold) / 1024,
    }),
  );
  await close();
  process.exit(0);
}

/**
 * One batch, sampled at 1ms, answering two questions that are not the
 * same.
 *
 * **What a call allocates.** Every fall in `heapUsed + external` is a
 * collection handing memory back; summed over the batch and added to what
 * the heap still holds at the end, that is everything the calls asked
 * for. Nothing in it depends on where a collection lands, which is what
 * made a per-call peak unmeasurable. The parent checks it against a
 * `--trace-gc` count taken out of this child's own stderr.
 *
 * **What the process peaks at.** The high-water of the same samples,
 * which is what the process has to be able to hold. It is not the same
 * ranking and is not meant to be: it is where the runtime chose to
 * collect, so a client that allocates a third as much can sit higher for
 * reaching the threshold a third as often.
 *
 * Long enough to settle, and longer where the calls are cheap, because
 * the per-call figure converges with the batch length.
 */
const iterations = Math.max(scenario.iters * 20, 100);
let highest = 0;
let highestRss = 0;
let collected = 0;
let previous = 0;

if (scenario.setup) await scenario.setup(db);
globalThis.gc();
globalThis.gc();
const batchBase = usedBytes();
previous = batchBase;

const watch = setInterval(() => {
  const usage = process.memoryUsage();
  const used = usage.heapUsed + usage.external;
  if (used > highest) highest = used;
  if (used < previous) collected += previous - used;
  previous = used;
  if (usage.rss > highestRss) highestRss = usage.rss;
}, 1);

// The parent runs this child under `--trace-gc` and adds up what each
// collection gave back between these two marks, as a check on the
// sampled figure that is arrived at a completely different way.
console.log(`MARK ${performance.now().toFixed(0)}`);
const receivedBefore = received;
const sentBefore = sent;
for (let i = 0; i < iterations; i++) await scenario.run(db, i);
console.log(`END ${performance.now().toFixed(0)}`);

clearInterval(watch);
const batchEnd = usedBytes();
if (batchEnd < previous) collected += previous - batchEnd;

console.log(
  JSON.stringify({
    driver: which,
    scenario: name,
    iterations,
    // what it holds warm, what a call costs, what the run peaks at, and
    // what crossed the socket in each direction
    heldKb: (atRest - cold) / 1024,
    allocPerCallKb: (batchEnd - batchBase + collected) / iterations / 1024,
    sustainedKb: (highest - cold) / 1024,
    sustainedRssKb: highestRss / 1024,
    wireKb: (received - receivedBefore) / 1024 / iterations,
    wireOutKb: (sent - sentBefore) / 1024 / iterations,
  }),
);

await close();
process.exit(0);
