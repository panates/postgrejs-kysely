/**
 * The largest row count an Execute message can ask for - PostgreSQL's
 * `maxRows` field is an unsigned 32-bit integer, and PostgreJS refuses
 * anything above this outright.
 *
 * This is what the dialect asks for by default, because PostgreJS's own
 * default of 100 truncates silently: a portal that suspends answers
 * PortalSuspended instead of CommandComplete, and `Connection.query()`
 * ignores that message and returns the rows that did arrive. A `select`
 * of 1000 rows comes back with 100 of them, no error and no flag. Zero is
 * not the escape hatch it is at the protocol level either - PostgreJS
 * reads `fetchCount || 100`, so 0 lands back on the truncating default.
 */
export const MAX_FETCH_COUNT = 4294967295;
