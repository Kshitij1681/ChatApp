/**
 * Ids at the edges of the system: the bound that "delete for me" reads back, and
 * the shape check every id from outside has to pass before it reaches a query.
 */

/**
 * The `_id` floor for one participant's cleared history, or null if they have
 * never cleared this conversation.
 *
 * `clearedUpTo` is the id of the newest message that existed at the moment they
 * cleared, so the split is exact: everything at or below it is theirs to stop
 * seeing, everything above it arrived afterwards and is live.
 *
 * It is an id and not a timestamp for a reason worth keeping written down. An
 * ObjectId's clock is second-granular, so a bound synthesised from a Date has to
 * round, and both roundings lose a message. Round down and anything sent later in
 * the same second sits above the bound and stays visible — cleared history
 * leaking straight back. Round up and a message arriving in the same second sits
 * below it and is hidden forever, so the thread never revives. There is no third
 * rounding; a date cannot express this boundary. The id can, exactly.
 *
 * A participant with no bound has cleared nothing — an empty conversation has no
 * history to hide, and a conversation destroyed for both has none left.
 */
export function clearedBound(state) {
  return state?.clearedUpTo ?? null;
}

const HEX24 = /^[0-9a-f]{24}$/i;

/**
 * An id from the outside world, or null.
 *
 * Anything reaching a query as an `_id` has to pass through here first. Handing
 * mongoose a string it cannot cast throws a CastError deep inside the driver,
 * which the error handler can only turn into a 500 — so a typo'd cursor reads
 * as "the server is broken" instead of "that isn't an id". Checking the shape
 * at the edge keeps the failure honest and the stack traces out of the log.
 */
export function asObjectId(value) {
  if (!value) return null;
  const text = String(value);
  return HEX24.test(text) ? text : null;
}
