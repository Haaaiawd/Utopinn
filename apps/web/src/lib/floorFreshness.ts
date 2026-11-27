// Floor-freshness gate — the pure predicate behind StageFrame's
// index-addressed write guard.
//
// The transcript addresses server floors by POSITION (/body/<m.id>): a
// delete/edit/swipe fired on a list that predates a floor mutation hits
// a different message. The list is stale — its index-addressed actions
// must stay disabled — while:
//   - a script run that can mutate floors is in flight
//     (chatMutationInFlight > 0; a /cut can land long before
//     /script/run resolves), or
//   - a mutation bump (chatRevision) landed after the list was fetched —
//     the list stamps the revision captured AT FETCH START, so a bump
//     mid-fetch leaves it stale by construction until a newer fetch
//     commits.
export const floorsStaleNow = (inFlight: number, floorsRev: number, chatRevision: number): boolean =>
    inFlight > 0 || floorsRev !== chatRevision;
