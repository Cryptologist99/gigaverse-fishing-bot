// Split a recorded turn list into individual CASTS. Some run files chain several fish into one
// turn list, with the prior fish's catch turn unlogged. A new cast begins where the turn index `n`
// is not previous+1, or where fishMaxHp changes. The `n` gap is the load-bearing signal: consecutive
// fish frequently share an HP, so an HP-only check silently merges them.
//
// Boundary detection reads each turn's ORIGINAL `n` (so a real gap is still visible), but every
// turn is then RENUMBERED 0..length-1 within its own cast before being returned. The original
// value is kept as `origN` for reference/debugging. Missing this step was a real bug found live
// 2026-09-14: casts split out correctly with no data mixed between fish, but a fish deep in a
// chain (e.g. the 8th of 8) kept displaying turns starting at its chain-wide index (T38 instead
// of T0), which reads exactly like the original merge-bug even though the underlying data was
// already correctly separated.
function splitCasts(turns, metaFishMaxHp) {
  const hpOf = t => (t.fishMaxHp != null ? t.fishMaxHp : metaFishMaxHp);
  const out = [];
  let cur = null;
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i], p = turns[i - 1];
    const boundary = i === 0
      || (t.n != null && p.n != null && t.n !== p.n + 1)
      || hpOf(t) !== hpOf(p);
    if (boundary) { cur = { fishMaxHp: hpOf(t), turns: [] }; out.push(cur); }
    cur.turns.push(t);
  }
  for (const cast of out) {
    cast.turns = cast.turns.map((t, i) => t.n != null && t.n !== i
      ? Object.assign({}, t, { origN: t.n, n: i })
      : t);
  }
  return out;
}
module.exports = { splitCasts };
