/**
 * The largest row count an Execute message can ask for - PostgreSQL's
 * `maxRows` field is an unsigned 32-bit integer, and PostgreJS refuses
 * anything above this outright.
 *
 * This is what the dialect asks for, rather than leaving the limit unsaid.
 * Kysely's contract is a complete result: `QueryResult` has nowhere to
 * report that rows were left behind, so a truncated one would reach the
 * caller as a short answer with nothing wrong about it. PostgreJS 3.6
 * fetches everything by default and flags a truncated result with
 * `suspended`, so this is belt and braces - but it is the one thing that
 * cannot be got wrong quietly, and saying it costs nothing.
 */
export const MAX_FETCH_COUNT = 4294967295;
