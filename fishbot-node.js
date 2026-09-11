#!/usr/bin/env node
/* ============================================================================
 * Gigaverse Fishing Bot — standalone Node CLI (calls the API directly, no browser).
 * ----------------------------------------------------------------------------
 * predict/positionsFor/lookahead/chooseAction implement the decision engine; jwt() reads
 * your token from token.txt; exportRun() writes each fish's turn-by-turn log as JSON.
 *
 * FIRST-TIME SETUP (see README.md for the full walkthrough):
 * 1. Log into gigaverse.io in a browser, open DevTools -> Console, run:
 *      copy(JSON.parse(localStorage.getItem('authResponse')).jwt)
 *    This copies your session token to the clipboard.
 * 2. Paste it into a new file named token.txt in this directory (just the raw token, nothing else).
 * 3. Find your wallet address (shown in the game's UI / your wallet), and pass it with --address=
 *    the first time you run the bot (or set cfg.address below permanently).
 * Re-do step 1-2 whenever the token expires (you'll see 401 errors).
 *
 * Running against a DIFFERENT account: create a second token file yourself the same way (e.g.
 * token-main.txt, in this directory), then pass --tokenFile and --address to point at it —
 * neither of these ever asks for or touches the JWT value itself.
 *
 * Usage:
 *   node fishbot-node.js --maxFish=1 --address=0xYOUR_ADDRESS
 *   node fishbot-node.js --maxFish=5 --address=0xYOUR_ADDRESS
 *   node fishbot-node.js --maxFish=1 --address=0xYOUR_ADDRESS --tokenFile=token-main.txt
 *
 * --maxFish=N means N fish TOTAL -- a loss ends the current game, not the batch; the bot just
 * starts a new one and keeps going until N fish have actually been played (win or loss) or the
 * account's daily fishing cap is hit. --maxGames is an optional extra safety cap on how many
 * separate games it's allowed to start along the way; unset (default) means no such cap.
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const API = 'https://gigaverse.io/api/fishing';
const G = 4;
const TOKEN_PATH = path.join(__dirname, 'token.txt');
const RUNS_DIR = path.join(__dirname, 'runs');

const cfg = {
  address:  null, // REQUIRED -- set via --address=0xYOUR_WALLET on the command line, or hardcode
                   // it here once you know it. There is no default; the bot refuses to start
                   // without one (see the check in the CLI entry point below).
  tokenFile: null, // path (relative to this file's dir, or absolute) to a JWT file, for running
                    // against an account other than the default -- overrides TOKEN_PATH below when
                    // set. The user creates this file themselves (paste the JWT into it directly,
                    // same as token.txt) -- never pass a JWT value on the command line or in chat.
  nodeId:   '5', tierId: 1, itemId: 0, slotIndex: 0,
  // Fishing oils: confirmed live 2026-09-10 that oils have NO pre-fight "equip" step at all --
  // the real action is `use_fishing_item` (data: {itemId, slotIndex, tierId}), which spends
  // directly from account inventory (GET /api/items/balances) any time mid-fight, capped at 3
  // uses/fight server-side ("Max consumables used this game (3)"). When enabled, the bot only
  // knows about one oil at a time (oilItemId -- boosts item/fish yield "this game", a persistent
  // per-game % boost once triggered for Dual Yield Oil specifically, not a per-turn effect) and
  // only uses it right before a likely catch (ration it, don't waste it on a fish that might still
  // escape). tierId's effect is unverified -- passing 0 always worked live for Lil-tier items;
  // kept configurable in case Big-tier items turn out to need a different value.
  //
  // OFF by default: using an oil spends real limited inventory on the user's actual account, so
  // the CLI asks interactively each run rather than silently deciding on its own -- see
  // promptForOilConfig() below, called from the CLI entry point only (never from library/test
  // usage of run()/playGame()). Passing --useOils=true (or any of the oil flags) on the command
  // line skips the prompt and uses the flag values directly, for scripted/non-interactive use.
  useOils: false, oilItemId: 972, oilTierId: 0, oilPHitThreshold: 0.75,
  // maxFish is a TOTAL across as many separate games as it takes -- a loss ends the current game,
  // not the batch; run() keeps starting new games until maxFish total fish have been played or
  // the daily cap is hit. maxGames is now just an optional extra safety cap on game count (null =
  // uncapped); most users never need it. See run()'s own comment for the reasoning.
  maxGames: null,
  maxFish: 6,
  maxTurns: 500, // was 60 -- too low for multi-fish batches: empirically ~5 turns/fish (n=83 real
                 // fish across today's runs, avg 4.96, worst single fish 10) and each real turn
                 // (play or redraw) costs >=1 mana, so one fish is inherently bounded by mana at
                 // worst -- but 60 total across a WHOLE maxFish batch meant a 9-10 fish run could
                 // exhaust it mid-catch, before loot() fired, leaving the account "already in a
                 // game" until the pendingDraft resume fix (below) recovered it. 500 comfortably
                 // covers a 50+ fish batch (500/~5 = ~100 fish worth of turns) while remaining a
                 // real cap, not effectively infinite, against a genuine runaway bug.
  enableRedraw: true,
  delayMs: 800, verbose: true,
  focusPenalty: 0.5,
  edgePenalty: 2.0, // shortlist-ranking heuristic only (decide()/positionsFor()'s ad-hoc score) --
                     // does NOT reach the real win-probability comparison, see edgeWinPenalty below.
  edgeWinPenalty: 0.2, // probability-scale penalty subtracted directly from playValue()'s real
                     // win-probability for a non-guaranteed-catch edge position, so the actual
                     // play-vs-redraw decision disfavors parking on the edge, not just which
                     // candidate positions get evaluated. Calibrated to flip the live 2026-09-09
                     // case (0.729 edge vs 0.609 equal-cost interior vs 0.504 redraw) toward the
                     // interior play; not yet validated against a larger live sample.
  catchBonus:    8,
  escapePenalty: 16,
  minHitToPlay:  0.5,
  reliableHit:   0.7,
  missTax:       2.0,
  hitWeight:     1.0,
  redrawMinReserve: 2,
  redrawEvFloor:     0.0,
  redrawBlindBonus:  1.5,
  redrawManaWeight:  0.35,
  redrawCostWeight:  0.6,
  // maxRedrawsPerFish REMOVED 2026-09-09 (per user): the real lookahead path already governs
  // redraw count without a magic number -- chooseAction() won't even evaluate a redraw unless
  // gs.playerHp >= gs.hand.length (can't afford it), evaluateRedraw() re-checks newMana<0 as a
  // backstop, and beyond raw affordability, leafEstimate's mana/playsNeeded affordability term
  // means a redraw that would leave too little mana to finish scores a LOWER win probability than
  // just playing -- so it naturally loses the redraw-vs-play comparison without needing a count
  // cap. Mana strictly decreases by >=1 per real redraw, so the number of redraws in a fight is
  // inherently self-limiting anyway. The old count cap was a leftover from the pre-lookahead
  // decide()/shouldRedraw() era; on a high-mana account it bound routinely (5 redraws attempted
  // live on a 14-mana account) and, before the chooseAction() fix above, silently degraded every
  // remaining play that fight to the crude single-turn heuristic.
  expectedHitRate:   0.75, // was 0.7 -- full-dataset recalibration (2026-09-09 audit, n=190):
                       // observed mobile (focus>0) hit rate is 0.747, not 0.7.
  stuckCoverageSlope: 0.32, // was 0.6 -- 0.6 assumed a "typical" narrow card is what's usually
                       // accessible while stuck, but a wide card is accessible almost every stuck
                       // turn in practice (best-accessible coverage >=0.89 in 28/28 stuck turns
                       // observed), so 0.6*coverage was scoring ~0.53 against a REAL observed
                       // stuck hit rate of just 0.286 (n=28; 0.25 at coverage 0.89 specifically,
                       // n=24) -- 2026-09-09 audit, full-dataset recalibration.
  redrawPlaysBuffer: 0,
  alternateMinHp: 21, // CONFIRMED by user 2026-09-09: 21-HP fish themselves CAN alternate (not just
                       // fish strictly above 21) -- do not raise this to 22. The 2026-09-09 audit's
                       // sample of 21-HP fish (n=8, all locked always-X after 1 move) undersampled
                       // true alternators at exactly 21; this is a settled game-mechanics fact, not
                       // a statistical judgment call.
  alternateContinuationPrior: 0.75, // P(next move continues at the SAME distance as the one just
                       // observed) for a canAlt-eligible fish after exactly one move. Measured live
                       // 2026-09-06: 5 of 6 canAlt fish settled into always-X after their first move,
                       // only 1 truly alternated (small n -- revisit). 0.75 is a conservative read of
                       // that ~83% point estimate. Re-checked 2026-09-09 against the full dataset
                       // (n=12 fish >=21hp): 10/12 same, 2/12 flip on the first transition (0.833),
                       // consistent with 0.75 -- left unchanged.
  threeMoveMinHp: 29, // CONFIRMED live 2026-09-10 (user): fish at 29hp+ can take a 3-STEP move in
                       // one turn (never seen below 29; user separately confirmed a 30hp fish shows
                       // it too). The real signal is PATH LENGTH (lastMovePath.length), not net
                       // Manhattan displacement -- a 3-step path can double back and land only 1 or
                       // 2 squares from start (mathematically, 3 orthogonal unit steps can only ever
                       // net to 1 or 3, never 0 or 2 -- parity: an even net in each axis needs an
                       // even step count on that axis, and two even counts can't sum to the odd
                       // total of 3). Confirmed against real history: only fishMaxHp=29 ever shows a
                       // 3-length path (9 of 56 recorded 29hp turns); every other size (14-30 except
                       // 29) never does. NOT every fish >=29hp uses it, though -- only 2 of 9 real
                       // 29hp fish encounters showed any 3-step move at all; the other 7 were
                       // ordinary always-1/always-2/alternating-1-2, identical to smaller fish. The
                       // two confirmed 3-capable fish each locked into a clean, perfectly regular
                       // alternation once measured by path length: one alternated 1<->3, the other
                       // 2<->3 -- never all three, never a fixed "always-3". Sample size is tiny (2
                       // real 3-capable fish, vs. the dozens that established alternateMinHp) --
                       // revisit thresholds/priors below as more real fish confirm or complicate this.
  threeMoveContinuationPrior: 0.75, // reuses alternateContinuationPrior's value/reasoning for now --
                       // NOT independently measured (no real data yet on how often a 3-capable fish
                       // continues at the same distance vs switches after one move). Placeholder
                       // pending more live 29hp+ fish.
  lookaheadDepth: 2,
  lookaheadMaxCombos: 15,
  lookaheadShortlist: 4,
  // Depth-3 escalation on close top-level calls (2026-09-09 audit item #5, implemented 2026-09-10):
  // full-dataset replay found 39% of real decisions (120/305) had a top-two depth-2 gap under 0.03,
  // and in the tightest band (0.001-0.003) going one ply deeper flipped ~75% of them -- 16/30
  // flipped overall across 0.001-0.0095, revealing TRUE gaps of 0.01-0.06 win probability depth-2
  // couldn't see. closeCallGap is the trigger threshold (matches the audit's own recommendation).
  closeCallGap: 0.01,
  // Hard wall-clock cap on ONE escalation attempt (both re-checked candidates combined). Depth-3
  // calls on real states ranged from <1s to 443s in the audit's unconstrained stress test -- with
  // no cap this could stall a turn indefinitely. lookaheadValue() checks this cooperatively (JS is
  // single-threaded/synchronous, so a real preemptive timeout isn't possible for pure CPU-bound
  // recursion) and throws LookaheadBudgetExceeded once spent; chooseAction() catches that and keeps
  // the original depth-2 ranking untouched -- escalation can only match or improve depth-2, never
  // make the decision worse or block play past this budget. 15s (user-approved 2026-09-10, raised
  // from 2000ms) -- this is pure local CPU time, no API/LLM cost, so the only real tradeoff is turn
  // latency during a live run.
  depth3TimeBudgetMs: 15000,
};

// Escalation-only cooperative timeout: lookaheadValue() checks this deadline and throws to unwind
// the whole in-flight depth-3 attempt once spent. A module-level variable (not threaded through
// state) is safe here because the engine is single-threaded and strictly synchronous per turn --
// there is never a second in-flight lookahead call this could leak into.
class LookaheadBudgetExceeded extends Error {}
let lookaheadDeadline = null;

let stop = false;
let lastRun = null;
let lastActionToken = null;
const log  = (...a) => cfg.verbose && console.log('[FishBot]', ...a);
const warn = (...a) => console.warn('[FishBot]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const jwt = () => fs.readFileSync(cfg.tokenFile ? path.resolve(__dirname, cfg.tokenFile) : TOKEN_PATH, 'utf8').trim();

/* ---- API ---------------------------------------------------------------- */
async function action(type, data, _retried) {
  const body = { action: type, actionToken: lastActionToken || String(Date.now()),
    data: Object.assign({ cards: [], nodeId: '', focusPoint: [], itemId: cfg.itemId, slotIndex: cfg.slotIndex, tierId: 0 }, data) };
  const res = await fetch(API + '/action', { method: 'POST',
    headers: { 'Authorization': 'Bearer ' + jwt(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.success === false) {
    if (res.status === 401) throw new Error(`${type} failed 401 Unauthorized — token.txt is expired, re-paste a fresh JWT`);
    // A new process boots with no memory of the last actionToken the server saw (fetchState()
    // doesn't return one between games), so it guesses Date.now(). The server's 400 for a bad
    // guess names the token it actually expected -- reuse that and retry once instead of failing
    // the whole run over a token the server told us outright.
    const msg = j.message || '';
    const m = !_retried && msg.match(/Invalid action token \d+ != (\d+)/);
    if (m) { lastActionToken = m[1]; return action(type, data, true); }
    throw new Error(`${type} failed ${res.status} ${msg}`);
  }
  if (j.actionToken != null) lastActionToken = j.actionToken;
  return j;
}
// Item balances live outside the fishing namespace entirely (GET /api/items/balances) -- same
// Bearer-token auth as everything else, confirmed live 2026-09-10. Browser-context fetch()
// without the real JWT header returns {"error":"No user provided"} even with cookies, so this
// only works via the bot's own token, same as fetchState()/action().
async function fetchOilBalance(itemId) {
  const res = await fetch('https://gigaverse.io/api/items/balances', { headers: { 'Authorization': 'Bearer ' + jwt() } });
  const j = await res.json().catch(() => ({}));
  const e = (j.entities || []).find(x => String(x.ID_CID) === String(itemId));
  return e ? e.BALANCE_CID : 0;
}
async function fetchState() {
  const res = await fetch(API + '/state/' + cfg.address, { headers: { 'Authorization': 'Bearer ' + jwt() } });
  if (res.status === 401) throw new Error('fetchState failed 401 Unauthorized — token.txt is expired, re-paste a fresh JWT');
  const j = await res.json();
  if (j && j.actionToken != null) lastActionToken = j.actionToken;
  return j.gameState && j.gameState.data;
}
const stateOf  = r => r && r.data && r.data.doc && r.data.doc.data;
const bar = g => `catch ${g.fishMaxHp - g.fishHp}/${g.fishMaxHp}`;

/* ---- geometry ----------------------------------------------------------- */
const inB = (r, c) => r >= 1 && r <= G && c >= 1 && c <= G;
const K   = (r, c) => r + ',' + c;
const man = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
const zoneCell = (z, fr, fc) => [fr + (Math.floor((z - 1) / 3) - 1), fc + (((z - 1) % 3) - 1)];
const coveredCells = (zones, fr, fc) => zones.map(z => zoneCell(z, fr, fc)).filter(c => inB(c[0], c[1]));
const orth = ([r, c]) => [[r-1,c],[r+1,c],[r,c-1],[r,c+1]].filter(([a,b]) => inB(a, b));

function effectAt(def, fr, fc, cell) {
  const hitAmt  = (def.hitEffects .find(e => e.type === 'FISH_HP') || {}).amount || 0;
  const missAmt = (def.missEffects.find(e => e.type === 'FISH_HP') || {}).amount || 0;
  const critAmt = (def.critEffects.find(e => e.type === 'FISH_HP') || {}).amount || hitAmt;
  for (const z of (def.critZones || [])) { const c = zoneCell(z, fr, fc); if (c[0] === cell[0] && c[1] === cell[1]) return critAmt; }
  for (const z of (def.hitZones  || [])) { const c = zoneCell(z, fr, fc); if (c[0] === cell[0] && c[1] === cell[1]) return hitAmt; }
  return missAmt;
}

// No-backtrack rule, generalized: a step can never reverse the step immediately before it WITHIN
// this walk. For dist===1 there's only one step, checked against `prev` (last turn's position) --
// that's the original always-1 rule ("never back to the square it was on last turn"). For s>=1 in
// a longer walk (dist 2 or 3), `last` is the walk's OWN previous step, not `prev` -- e.g. step 3 of
// a 3-move can't undo step 2. s===0 of a dist>=2 walk is deliberately left unconstrained against
// `prev`: for dist=2 this is already validated (the existing "never nets to 0" filter below already
// excludes an exact reversal, since 2 opposite unit steps always net to 0 -- adding a redundant
// per-step check here for s=0 doesn't change dist=2's result at all, just moves the same exclusion
// earlier). For dist=3, nothing in real data supports a rule constraining step 1 against `prev`
// specifically, so it stays open, same conservative stance as dist=2's s=0.
function backtracks(dist, s, last, nb) {
  if (!last) return false;
  if (!(dist === 1 || s >= 1)) return false;
  return nb[0] === last[0] && nb[1] === last[1];
}
function reachable(cell, prev, dist) {
  let f = new Map([[K(...cell), { c: cell, last: prev }]]);
  for (let s = 0; s < dist; s++) {
    const n = new Map();
    for (const { c: cur, last } of f.values())
      for (const nb of orth(cur)) {
        if (backtracks(dist, s, last, nb)) continue;
        n.set(K(...nb), { c: nb, last: cur });
      }
    f = n;
  }
  return [...f.values()].map(v => v.c).filter(c => !(c[0] === cell[0] && c[1] === cell[1]));
}

// Same walk as reachable(), but counts DISTINCT PATHS to each end cell instead of just the
// set of end cells. A 2-move fish taking two independent orthogonal steps reaches a "diagonal"
// square via TWO path combinations (right-then-up or up-then-right) but a straight two-in-a-row
// square via only ONE, so diagonal squares are twice as likely, not equally likely. For dist=1
// every reachable cell has exactly one path, so this reduces to uniform automatically. For dist=3
// this same path-count weighting is untested against real data (only 2 confirmed 3-capable fish
// so far, not enough to validate a diagonal-style skew the way 2-move was) -- carries the same
// no-backtrack rule (see backtracks()) forward by construction, nothing more assumed yet.
function reachableWeighted(cell, prev, dist) {
  let f = new Map([[K(...cell) + '|' + (prev ? K(...prev) : '-'), { c: cell, last: prev, w: 1 }]]);
  for (let s = 0; s < dist; s++) {
    const n = new Map();
    for (const { c: cur, last, w } of f.values())
      for (const nb of orth(cur)) {
        if (backtracks(dist, s, last, nb)) continue;
        const key = K(...nb) + '|' + K(...cur);
        const existing = n.get(key);
        if (existing) existing.w += w; else n.set(key, { c: nb, last: cur, w });
      }
    f = n;
  }
  const totals = new Map();
  for (const { c, w } of f.values()) {
    if (c[0] === cell[0] && c[1] === cell[1]) continue;
    const key = K(...c);
    totals.set(key, (totals.get(key) || 0) + w);
  }
  return [...totals.entries()].map(([key, w]) => { const [r, c] = key.split(',').map(Number); return { cell: [r, c], w }; });
}

/* ---- fish-move inference ------------------------------------------------ */
// moveLens (opts.moveLens, optional): the REAL step count (lastMovePath.length) for each observed
// transition, parallel to the position history. Needed because net Manhattan distance between
// positions is only an unambiguous proxy for step count up through dist=2 -- a 3-step move can
// double back and land just 1 or 2 squares from start (see threeMoveMinHp's comment), so a
// 3-capable fish's classification MUST use real path length, not position deltas, or it silently
// miscounts some 3-step moves as 1-step ones. Only ever available for REAL turns (playGame()
// threads it from gs.lastMovePath); recursive/simulated lookahead branches have no real path for a
// hypothetical future cell and fall back to net-distance via man() -- an accepted approximation,
// same class as the pre-existing one (net distance was always exact for dist<=2, so this gap only
// exists for 3-capable fish and only in the simulated-future case).
function predict(history, opts) {
  const canAlt = !opts || opts.canAlternate !== false;
  const canThree = !!(opts && opts.canThree);
  const cur = history[history.length - 1];
  const prev = history.length >= 2 ? history[history.length - 2] : null;
  const tel = opts && opts.telegraph;
  if (Array.isArray(tel) && tel.length === 2 && inB(tel[0], tel[1]))
    return { cand: [{ cell: [tel[0], tel[1]], p: 1 }], exact: true, regimeKnown: true, why: 'fintuition telegraph' };
  const moveLens = opts && opts.moveLens;
  const dists = [];
  for (let i = 1; i < history.length; i++) {
    const known = moveLens && moveLens[i - 1] != null ? moveLens[i - 1] : man(history[i-1], history[i]);
    dists.push(known);
  }
  const unionW = () => {
    const totals = new Map();
    for (const d of (canThree ? [1, 2, 3] : [1, 2])) {
      for (const { cell, w } of reachableWeighted(cur, prev, d)) {
        const key = K(...cell);
        const e = totals.get(key);
        if (e) e.w += w; else totals.set(key, { cell, w });
      }
    }
    return [...totals.values()];
  };
  // After exactly ONE observed move, favor the fish CONTINUING at that same distance over
  // switching to a different one -- most alternation-eligible fish settle into a fixed always-X
  // regime rather than genuinely alternate (measured live: 5 of 6 canAlt fish today locked into
  // always-X after their first move; only 1 truly alternated -- see alternateContinuationPrior).
  // Each distance-branch is normalized to its own probabilities first, then scaled by the prior
  // and merged -- scaling raw path-weights directly would distort the mix whenever branches have
  // different total path counts. Generalized for canThree: "other" now has TWO candidate distances
  // instead of one, splitting the non-continuation share evenly between them (unvalidated 50/50
  // split -- see threeMoveContinuationPrior's comment; only reduces to the original exact behavior
  // when canThree is false, since then "others" has exactly one entry).
  const favorContinuation = (distSame) => {
    const others = canThree ? [1, 2, 3].filter(d => d !== distSame) : [distSame === 1 ? 2 : 1];
    const prior = canThree ? cfg.threeMoveContinuationPrior : cfg.alternateContinuationPrior;
    const sumW = arr => arr.reduce((s, x) => s + x.w, 0);
    const totals = new Map();
    const add = (arr, total, share) => { if (total <= 0 || share <= 0) return;
      for (const { cell, w } of arr) { const key = K(...cell), scaled = (w / total) * share;
        const e = totals.get(key); if (e) e.w += scaled; else totals.set(key, { cell, w: scaled }); } };
    const branchSame = reachableWeighted(cur, prev, distSame);
    add(branchSame, sumW(branchSame), prior);
    const otherShare = (1 - prior) / others.length;
    others.forEach(d => { const branch = reachableWeighted(cur, prev, d); add(branch, sumW(branch), otherShare); });
    return [...totals.values()];
  };
  let W, why, regimeKnown = true;
  if (!dists.length) { W = unionW(); why = 'regime unknown (cover 1+2' + (canThree ? '+3' : '') + ')'; regimeKnown = false; }
  else if (!canAlt) { const dist = dists.every(t => t === 2) ? 2 : 1; W = reachableWeighted(cur, prev, dist); why = 'regime always-' + dist + ' (≤21hp, locked)'; }
  else if (dists.length < 2) { W = favorContinuation(dists[0]); why = 'could still alternate (favor dist-' + dists[0] + ' continuing)'; regimeKnown = false; }
  else {
    const last = dists[dists.length - 1];
    const distinct = [...new Set(dists)];
    const allSame = distinct.length === 1;
    const strictlyAlternates = dists.every((t, i) => i === 0 || t !== dists[i - 1]);
    let dist;
    if (allSame) { dist = distinct[0]; why = 'regime always-' + dist; }
    else if (strictlyAlternates && distinct.length === 2) {
      dist = distinct.find(v => v !== last);
      const pairStr = distinct.slice().sort((a, b) => a - b).join('<->');
      // Preserve the exact legacy string for the already-established 1<->2 case (existing
      // tests/log-scanning scripts match against literal "alternating -> N"); only the NEW pairs
      // this change introduces (1<->3, 2<->3) get the explicit pair annotation, since there was
      // previously no other alternating pair possible to distinguish from.
      why = pairStr === '1<->2' ? 'regime alternating -> ' + dist : 'regime alternating ' + pairStr + ' -> ' + dist;
    }
    else { dist = last; why = 'regime mixed -> ' + dist; }
    W = reachableWeighted(cur, prev, dist);
  }
  const totalW = W.reduce((s, x) => s + x.w, 0);
  const cand = W.map(({ cell, w }) => ({ cell, p: w / totalW }));
  return { cand, exact: W.length === 1, regimeKnown, why };
}

/* ---- action selection (single-turn fallback, used when fullDeck is unknown) --------- */
function decide(gs, pr) {
  const defs = {}; (gs.deckCardData || []).forEach(d => defs[d.id] = d);
  const bob = gs.focusPoint;
  const focus = gs.focusMeter || 0;
  let best = null;

  const onEdge = (r, c) => r === 1 || r === G || c === 1 || c === G;
  const catchBar = gs.fishMaxHp - gs.fishHp;
  let handTopPHit = 0;
  (gs.hand || []).forEach((cardId, handIdx) => {
    const def = defs[cardId]; if (!def) return;
    const mana = def.manaCost ?? 1;
    if (mana > gs.playerHp) return;
    const hitAmt = (def.hitEffects.find(e => e.type === 'FISH_HP') || {}).amount || 0;
    for (let fr = 1; fr <= G; fr++) for (let fc = 1; fc <= G; fc++) {
      const moveCost = man(bob, [fr, fc]);
      if (moveCost > focus) continue;
      let ev = 0, pHit = 0, allCovered = true;
      for (const { cell, p } of pr.cand) {
        const a = effectAt(def, fr, fc, cell);
        let val = a;
        if (a > 0 && catchBar + a >= gs.fishMaxHp) val += cfg.catchBonus;
        else if (a < 0 && catchBar + a <= 0)       val -= cfg.escapePenalty;
        ev += p * val;
        if (a > 0) pHit += p; else allCovered = false;
      }
      ev -= (1 - pHit) * cfg.missTax;
      if (pHit > handTopPHit) handTopPHit = pHit;
      const guaranteedCatch = allCovered && pr.cand.length > 0 && (catchBar + hitAmt >= gs.fishMaxHp);
      const edgePen = (onEdge(fr, fc) && !guaranteedCatch) ? cfg.edgePenalty : 0;
      const score = ev - cfg.focusPenalty * moveCost - edgePen - 0.5 * (mana - 1) + cfg.hitWeight * pHit;
      if (!best || score > best.score)
        best = { handIdx, cardId, mana, focus: [fr, fc], moveCost, ev, pHit, guaranteedCatch, score };
    }
  });
  if (best) best.handTopPHit = handTopPHit;
  return best;
}

function hitsToCatch(gs) {
  const dmgs = (gs.deckCardData || [])
    .map(d => ((d.hitEffects || []).find(e => e.type === 'FISH_HP') || {}).amount || 0).filter(x => x > 0);
  const avgDmg = dmgs.length ? dmgs.reduce((a, b) => a + b, 0) / dmgs.length : 5;
  return Math.max(1, Math.ceil(gs.fishHp / avgDmg));
}
function drawPool(gs) {
  const c = {}; (gs.fullDeck || []).forEach(id => c[id] = (c[id] || 0) + 1);
  const afterHand = Object.assign({}, c);
  (gs.hand || []).forEach(id => { if (c[id] > 0) c[id]--; if (afterHand[id] > 0) afterHand[id]--; });
  (gs.discard || []).forEach(id => { if (c[id] > 0) c[id]--; });
  const toIds = o => { const a = []; for (const id in o) for (let i = 0; i < o[id]; i++) a.push(+id); return a; };
  const pile = toIds(c);
  return pile.length >= 3 ? pile : toIds(afterHand);
}
function shouldRedraw(gs, best, pr) {
  if (!best) return true;
  if (best.guaranteedCatch) return false;
  const topPHit = Math.max(best.pHit || 0, best.handTopPHit || 0);
  if (topPHit >= cfg.reliableHit) return false;
  const handSize = (gs.hand || []).length;
  if (handSize === 0) return false;
  const playsAfter = gs.playerHp - handSize;
  if (playsAfter < cfg.redrawMinReserve) return false;
  const playsNeeded = Math.ceil(hitsToCatch(gs) / cfg.expectedHitRate) + cfg.redrawPlaysBuffer;
  if (playsAfter < playsNeeded) return false;
  const defs = {}; (gs.deckCardData || []).forEach(d => defs[d.id] = d);
  const bestScore = ids => ids.length ? Math.max(...ids.map(id => defs[id] ? scoreCard(defs[id]) : -99)) : -99;
  const poolBest = bestScore(drawPool(gs)), handBest = bestScore(gs.hand || []);
  const known = poolBest > -99 && handBest > -99;
  const poolBetter = !known || poolBest > handBest;
  const wouldHeal = best.ev < 0;
  if (best.pHit < cfg.minHitToPlay) return poolBetter || wouldHeal;
  const blind = pr && pr.regimeKnown === false;
  const spareMana = gs.playerHp - cfg.redrawMinReserve;
  const scout = blind ? (cfg.redrawBlindBonus + cfg.redrawManaWeight * spareMana) : 0;
  const floor = cfg.redrawEvFloor + scout - cfg.redrawCostWeight * handSize;
  if (best.ev >= floor) return false;
  return poolBetter || wouldHeal;
}

/* ---- lookahead ------------------------------------------------------------------ */
const LA_WIN = 1, LA_LOSS = 0;

function combos(arr, k) {
  const n = arr.length, out = [];
  (function rec(start, chosen) {
    if (chosen.length === k) { out.push(chosen.slice()); return; }
    for (let i = start; i <= n - (k - chosen.length); i++) { chosen.push(arr[i]); rec(i + 1, chosen); chosen.pop(); }
  })(0, []);
  return out;
}

function positionsFor(def, bobber, focus, pr, catchBar, fishMaxHp) {
  const hitAmt = (def.hitEffects && def.hitEffects.find(e => e.type === 'FISH_HP') || {}).amount || 0;
  const onEdge = (r, c) => r === 1 || r === G || c === 1 || c === G;
  const out = [];
  for (let fr = 1; fr <= G; fr++) for (let fc = 1; fc <= G; fc++) {
    const moveCost = man(bobber, [fr, fc]);
    if (moveCost > focus) continue;
    const branches = pr.cand.map(({ cell, p }) => ({ cell, p, a: effectAt(def, fr, fc, cell) }));
    let ev = 0, pHit = 0, allCovered = true;
    branches.forEach(b => { ev += b.p * b.a; if (b.a > 0) pHit += b.p; else allCovered = false; });
    const guaranteedCatch = catchBar != null && allCovered && branches.length > 0 && (catchBar + hitAmt >= fishMaxHp);
    const edgeNonCatch = onEdge(fr, fc) && !guaranteedCatch;
    const edgePen = edgeNonCatch ? cfg.edgePenalty : 0;
    const score = ev + cfg.hitWeight * pHit - cfg.focusPenalty * moveCost - edgePen;
    out.push({ focus: [fr, fc], moveCost, branches, score, ev, edgeNonCatch });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}
const bestPositionFor = (def, bobber, focus, pr, catchBar, fishMaxHp) =>
  positionsFor(def, bobber, focus, pr, catchBar, fishMaxHp)[0] || null;

function avgHitDmg(ids, defs) {
  const dmgs = (ids || []).map(id => defs[id]).filter(Boolean)
    .map(d => ((d.hitEffects || []).find(e => e.type === 'FISH_HP') || {}).amount || 0).filter(x => x > 0);
  return dmgs.length ? dmgs.reduce((a, b) => a + b, 0) / dmgs.length : null;
}
// Best board-coverage fraction (hit+crit zones / 9) among the given cards -- a cheap, O(1)
// per-card, NO-RECURSION proxy for "how good is this hand if the bobber can never move again."
function bestCoverage(ids, defs) {
  const covs = (ids || []).map(id => defs[id]).filter(Boolean)
    .map(d => (((d.hitZones || []).length + (d.critZones || []).length) / 9));
  return covs.length ? Math.max(...covs) : null;
}
// Average miss-heal MAGNITUDE (positive number of catch-bar HP a miss gives back) among the
// given cards -- same accessible-set convention as avgHitDmg, used so leafEstimate's plays-needed
// math can net misses against hits instead of pretending misses cost nothing (see leafEstimate).
function avgMissHeal(ids, defs) {
  // NOT filtered to x>0 like avgHitDmg's hitAmt filter: a missAmt of exactly 0 is real data (a
  // card that genuinely doesn't heal the fish on a miss, e.g. card 16/17), not a missing-data
  // marker the way hitAmt=0 marks a crit-only card that never lands a plain hit. Excluding 0s here
  // would bias the average upward and mask genuinely safe cards in the accessible set.
  const cards = (ids || []).map(id => defs[id]).filter(Boolean);
  const heals = cards.map(d => -(((d.missEffects || []).find(e => e.type === 'FISH_HP') || {}).amount || 0));
  return heals.length ? heals.reduce((a, b) => a + b, 0) / heals.length : null;
}
function leafEstimate(fishHp, fishMaxHp, mana, focus, defs, hand, pool) {
  const progress = Math.max(0, Math.min(1, (fishMaxHp - fishHp) / fishMaxHp));
  if (fishHp <= 0) return 1;
  // hand+pool together, not hand-then-pool as separate fallback tiers: everything in the pool is
  // reachable via redraw, so it's part of "what I could realistically be playing later" just as
  // much as what's currently sitting in hand. Using hand-only here created a real bug -- when
  // comparing two candidate cards to play THIS turn, whichever one you DON'T play stays in the
  // post-play hand, so hand-only bestCoverage credited "I kept the wide card in my literal hand"
  // as insurance, even when an equally-wide card already sat in the pool regardless of which card
  // got played. That made leafEstimate systematically favor holding onto wide cards past their
  // real value, and the bias was worse the less depth of real recursion was left to correct it
  // (confirmed: stress-testing a real Gideon T3 decision at depth 3 vs depth 2 showed the
  // hand-only version's artificial preference for a 10%-hit card over a 20%-hit card collapsing
  // by ~85%, while every other leafEstimate change this session got MORE confident with depth).
  const accessible = (hand || []).concat(pool || []);
  const avgDmg = avgHitDmg(accessible, defs) ?? avgHitDmg(Object.keys(defs || {}), defs) ?? 5;
  // A focus=0 bobber is FIXED — it can no longer chase the fish's predicted cell, so its real
  // hit rate craters versus a mobile one. Measured across today's live runs: 76.7% hit rate
  // with focus>0 (can reposition) vs only 17.6% stuck at focus=0 (n=103 vs n=17) — this used
  // to be invisible to the model because leafEstimate only ever discounted for low MANA, never
  // for having no FOCUS left, so any turn beyond the real lookahead horizon assumed a stranded
  // bobber would keep hitting at the same rate as a mobile one.
  //
  // That flat 17.6%-derived constant was itself blind to WHICH cards you'd actually be stuck
  // with -- a wide-coverage card is nowhere near as painful to be stuck with as a narrow one,
  // and n=17 mixed both indiscriminately. Scale by the best available card's actual board
  // coverage instead (cheap: just reading zone-array lengths already on the card defs, no
  // recursion). cfg.stuckCoverageSlope is calibrated so a "typical" narrow 3-zone card
  // (coverage 1/3) reproduces the original measured 0.2.
  const effectiveHitRate = focus > 0 ? cfg.expectedHitRate
    : Math.min(cfg.expectedHitRate, cfg.stuckCoverageSlope * (bestCoverage(accessible, defs) ?? bestCoverage(Object.keys(defs || {}), defs) ?? (1/3)));
  // playsNeeded used to be ceil(fishHp/avgDmg)/hitRate -- i.e. it assumed a miss costs NOTHING
  // beyond not progressing. Really a miss actively HEALS the fish (catch bar moves backward), so
  // net progress per play is hitRate*avgDmg MINUS (1-hitRate)*avgHeal, not just hitRate*avgDmg.
  // Ignoring the heal term made the leaf ~37% too optimistic about affordability (2026-09-09 audit:
  // observed realized progress 2.58 HP/play, n=218, vs. the old formula's implied 3.54).
  const avgHeal = avgMissHeal(accessible, defs) ?? avgMissHeal(Object.keys(defs || {}), defs) ?? 3;
  const netPerPlay = Math.max(0.5, effectiveHitRate * avgDmg - (1 - effectiveHitRate) * avgHeal);
  const playsNeeded = fishHp / netPerPlay;
  const affordability = playsNeeded > 0 ? Math.max(0, Math.min(1, mana / playsNeeded)) : 1;
  return progress * affordability;
}

function playValue(defs, def, pos, cardId, handIdx, state, depth) {
  const { hand, mana, focus, fishHp, fishMaxHp, hist, fullDeck, discard, canAlt, canThree } = state;
  const cMana = def.manaCost ?? 1;
  let val = 0;
  for (const { cell, p, a } of pos.branches) {
    const newFishHp = fishHp - a;
    let branch;
    if (a > 0 && newFishHp <= 0) branch = LA_WIN;
    else if (a < 0 && newFishHp >= fishMaxHp) branch = LA_LOSS;
    else {
      const newMana = mana - cMana;
      const newHand = hand.slice(); newHand.splice(handIdx, 1);
      if (newMana <= 0) branch = LA_LOSS;
      else if (depth > 0) {
        branch = lookaheadValue(defs, { hand: newHand, mana: newMana, focus: focus - pos.moveCost,
          bobber: pos.focus, fishHp: newFishHp, fishMaxHp, hist: hist.concat([cell]),
          fullDeck, discard: (discard || []).concat([cardId]), canAlt, canThree }, depth - 1);
      } else branch = leafEstimate(newFishHp, fishMaxHp, newMana, focus - pos.moveCost, defs, newHand, drawPool({ fullDeck, hand: newHand, discard: (discard || []).concat([cardId]) }));
    }
    val += p * branch;
  }
  // positionsFor()'s edgePen only ever biased the SHORTLIST ranking (which few positions get the
  // expensive recursive evaluation below) -- once a non-guaranteed-catch edge position survived
  // that ranking, this real win-probability value had no edge-awareness at all, so a high-immediate-
  // pHit edge move could still win the actual play-vs-redraw decision outright even with mana to
  // spare for a redraw. Confirmed live 2026-09-09: an edge move scored 0.729 here (vs 0.609 for an
  // equal-focus-cost interior card, vs 0.504 to redraw with 11/14 mana still in the bank) and got
  // played, then the bobber sat stuck at the edge with focus down to 1 for the rest of the fight and
  // lost. Applied on this same probability scale (unlike cfg.edgePenalty, an unrelated ad-hoc
  // score used only for shortlisting) so it lands in the actual comparison chooseAction() makes.
  if (pos.edgeNonCatch) val -= cfg.edgeWinPenalty;
  return val;
}

// Multiset subtraction: pool minus one occurrence of each id in drawn (drawn is a sub-multiset of
// pool by VALUE, not by array position, since combos() only tracks which ids were chosen -- used
// to hand leafEstimate the actual remaining draw pool after a redraw instead of nothing (see
// evaluateRedraw).
function removeDrawn(pool, drawn) {
  const p = (pool || []).slice();
  for (const id of (drawn || [])) { const i = p.indexOf(id); if (i !== -1) p.splice(i, 1); }
  return p;
}
function evaluateRedraw(defs, state, depth, cost) {
  const { hand, mana, focus, bobber, fishHp, fishMaxHp, hist, fullDeck, discard, canAlt, canThree, telegraph } = state;
  const newMana = mana - cost;
  if (newMana < 0) return -Infinity;
  // Redrawing doesn't change whether/where the fish moves this turn -- a live telegraph (only
  // ever set on the top-level state, see chooseAction()) is just as valid here as it was for the
  // `pr` chooseAction() already computed for the play-side comparison.
  const pr = predict(hist, { canAlternate: canAlt, canThree, telegraph });
  const pool = drawPool({ fullDeck, hand, discard });
  const drawN = Math.min(3, pool.length);
  if (drawN === 0) return -Infinity;
  let handCombos = combos(pool, drawN);
  if (handCombos.length > cfg.lookaheadMaxCombos) {
    const step = handCombos.length / cfg.lookaheadMaxCombos;
    handCombos = Array.from({ length: cfg.lookaheadMaxCombos }, (_, i) => handCombos[Math.floor(i * step)]);
  }
  const pHand = 1 / handCombos.length;
  let val = 0;
  for (const { cell, p: pCell } of pr.cand) {
    for (const newHand of handCombos) {
      const jp = pCell * pHand;
      let branch;
      if (newMana <= 0) branch = LA_LOSS;
      else if (depth > 0) branch = lookaheadValue(defs, { hand: newHand, mana: newMana, focus, bobber,
        fishHp, fishMaxHp, hist: hist.concat([cell]), fullDeck, discard: (discard || []).concat(hand), canAlt, canThree }, depth - 1);
      else branch = leafEstimate(fishHp, fishMaxHp, newMana, focus, defs, newHand, removeDrawn(pool, newHand));
      val += jp * branch;
    }
  }
  return val;
}

// Position choice here uses the same shortlist+rerank-by-real-value technique as
// chooseAction() (not bare bestPositionFor()'s single heuristic-best position) -- this matters
// most exactly when a card only wins via a low-probability branch (e.g. a crit-only finish):
// bestPositionFor()'s generic ev/pHit/focus-cost score has no notion of "does this land the
// kill", so it can park a card on a position with high overall EV but a WORSE chance of the
// specific lethal branch, silently undervaluing the true best line one level down in the
// recursion (confirmed against a live game: it picked a 25%-lethal position for a crit-dependent
// card when a 50%-lethal position was available with the same card).
function lookaheadValue(defs, state, depth) {
  if (lookaheadDeadline !== null && Date.now() > lookaheadDeadline) throw new LookaheadBudgetExceeded();
  const { hand, mana, focus, bobber, fishHp, fishMaxHp, hist, canAlt, canThree } = state;
  if (mana <= 0) return LA_LOSS;
  if (hand.length === 0) return evaluateRedraw(defs, state, depth, 0);
  const pr = predict(hist, { canAlternate: canAlt, canThree });
  const catchBar = fishMaxHp - fishHp;
  let best = -Infinity;
  hand.forEach((cardId, handIdx) => {
    const def = defs[cardId]; if (!def) return;
    if ((def.manaCost ?? 1) > mana) return;
    const candidates = positionsFor(def, bobber, focus, pr, catchBar, fishMaxHp).slice(0, cfg.lookaheadShortlist);
    for (const pos of candidates) {
      const val = playValue(defs, def, pos, cardId, handIdx, state, depth);
      if (val > best) best = val;
    }
  });
  if (mana >= hand.length) {
    const rv = evaluateRedraw(defs, state, depth, hand.length);
    if (rv > best) best = rv;
  }
  return best === -Infinity ? LA_LOSS : best;
}

function chooseAction(gs, hist, pr, allowRedraw) {
  const defs = {}; (gs.deckCardData || []).forEach(d => defs[d.id] = d);
  // allowRedraw===false now only comes from cfg.enableRedraw being explicitly off (no more
  // count-based cap -- see the maxRedrawsPerFish removal note in cfg). It should only take the
  // REDRAW option off the table, not degrade every play decision for the rest of the fight, so
  // full lookahead for PLAY still runs below; only the evaluateRedraw() call is skipped.
  //
  // Deck composition unknown (no fullDeck) is a genuinely different situation -- real lookahead
  // needs the drawable pool to model a redraw at all, so this keeps the old decide()/shouldRedraw()
  // fallback regardless of allowRedraw.
  if (!gs.fullDeck || !gs.fullDeck.length) {
    if (allowRedraw === false) {
      const mv = decide(gs, pr);
      return mv ? { type: 'play', mv } : { type: 'none' };
    }
    const mv = decide(gs, pr);
    return (shouldRedraw(gs, mv, pr) || !mv) ? { type: 'redraw' } : { type: 'play', mv };
  }
  const depth = cfg.lookaheadDepth;
  const canAlt = gs.fishMaxHp >= cfg.alternateMinHp;
  const canThree = gs.fishMaxHp >= cfg.threeMoveMinHp;
  // telegraph (fintuition skill: reveals the fish's exact next square) only tells us about THIS
  // turn's move, not any hypothetical future turn -- so it belongs on the state object built HERE
  // (the real current decision), not on the fresh state objects playValue()/evaluateRedraw() build
  // for recursing into hypothetical future turns (those already omit it, so it naturally doesn't
  // leak deeper). Without this, evaluateRedraw()'s own re-prediction ignored a live telegraph even
  // when this turn's own `pr` already used it, silently blind for that one call.
  const telegraph = pr.exact && pr.why === 'fintuition telegraph' ? pr.cand[0].cell : undefined;
  const state = { hand: gs.hand || [], mana: gs.playerHp, focus: gs.focusMeter, bobber: gs.focusPoint,
    fishHp: gs.fishHp, fishMaxHp: gs.fishMaxHp, hist, fullDeck: gs.fullDeck, discard: gs.discard, canAlt, canThree, telegraph };
  let bestPlay = null;
  // handEval: the same real win-probability lookahead already computed here for EVERY hand card
  // (not just the one ultimately chosen) -- previously thrown away once bestPlay was picked. Saved
  // onto the turn snapshot in playGame() so the run data (and the Bobber Replay viewer) can show
  // what each card in hand was actually worth this turn, not just the played one.
  const handEval = [];
  // posByHandIdx: internal only (not part of handEval's recorded shape) -- keeps each card's
  // winning position/branches around so a depth-3 escalation (below) can re-run playValue one ply
  // deeper on the SAME position instead of re-searching the board.
  const posByHandIdx = {};
  // zeroCostByHandIdx: the best MOVECOST===0 candidate for each card, kept separately from bestPos
  // -- bestPos is chosen purely by recursive value and may well be a position that DOES spend focus
  // (as happened live: card16's highest-value position cost 1 focus even though a 0-cost position
  // was also in its shortlist), so relying on bestPos alone would miss a genuinely free play. Used
  // below by the zero-miss-penalty-card-beats-redraw rule, which specifically needs "can this be
  // played at zero focus cost", not "what's this card's single best-valued position".
  const zeroCostByHandIdx = {};
  (gs.hand || []).forEach((cardId, handIdx) => {
    const def = defs[cardId]; if (!def) return;
    const cMana = def.manaCost ?? 1;
    if (cMana > gs.playerHp) { handEval.push({ cardId, handIdx, affordable: false }); return; }
    const candidates = positionsFor(def, gs.focusPoint, gs.focusMeter, pr, gs.fishMaxHp - gs.fishHp, gs.fishMaxHp)
      .slice(0, cfg.lookaheadShortlist);
    let bestPos = null, zeroCost = null;
    for (const pos of candidates) {
      const val = playValue(defs, def, pos, cardId, handIdx, state, depth);
      if (!bestPos || val > bestPos.val) bestPos = { pos, val };
      if (pos.moveCost === 0 && (!zeroCost || val > zeroCost.val)) zeroCost = { pos, val };
    }
    if (zeroCost) {
      const pHitZero = zeroCost.pos.branches.filter(b => b.a > 0).reduce((s, b) => s + b.p, 0);
      zeroCostByHandIdx[handIdx] = { cardId, val: zeroCost.val, pos: zeroCost.pos, pHit: pHitZero };
    }
    if (!bestPos) { handEval.push({ cardId, handIdx, affordable: true, playable: false }); return; }
    posByHandIdx[handIdx] = bestPos.pos;
    const pHit = bestPos.pos.branches.filter(b => b.a > 0).reduce((s, b) => s + b.p, 0);
    // crit chance specifically (not just "landed on any scoring zone") -- checked directly against
    // this card's own critZones at its best position, same zone math effectAt() uses.
    const [fr, fc] = bestPos.pos.focus;
    const critChance = (def.critZones && def.critZones.length)
      ? pr.cand.filter(c => def.critZones.some(z => { const zc = zoneCell(z, fr, fc); return zc[0] === c.cell[0] && zc[1] === c.cell[1]; })).reduce((s, c) => s + c.p, 0)
      : 0;
    handEval.push({ cardId, handIdx, affordable: true, playable: true, val: bestPos.val,
      pHit: +pHit.toFixed(3), critChance: +critChance.toFixed(3), focus: bestPos.pos.focus, moveCost: bestPos.pos.moveCost });
    if (!bestPlay || bestPos.val > bestPlay.val) bestPlay = { val: bestPos.val, handIdx, cardId, mana: cMana, focus: bestPos.pos.focus, moveCost: bestPos.pos.moveCost, pHit, ev: bestPos.pos.ev };
  });
  let redrawVal = -Infinity;
  if (allowRedraw !== false && (gs.hand || []).length > 0 && gs.playerHp >= gs.hand.length) {
    redrawVal = evaluateRedraw(defs, state, depth, gs.hand.length);
  }

  // --- depth-3 escalation on a close top-level call (audit item #5, see cfg.closeCallGap) -----
  // Scoped to ONLY the top-two candidates at the TOP level, not recursively inside lookaheadValue's
  // own future-ply search -- escalating there too would multiply the branching factor through the
  // whole tree, the same blowup the shortlist-rerank fix upstream of this deliberately avoided.
  let escalated = false;
  if (cfg.closeCallGap > 0) {
    const cands = handEval.filter(h => h.playable)
      .map(h => ({ kind: 'play', handIdx: h.handIdx, cardId: h.cardId, val: h.val }));
    if (redrawVal > -Infinity) cands.push({ kind: 'redraw', val: redrawVal });
    cands.sort((a, b) => b.val - a.val);
    if (cands.length >= 2 && (cands[0].val - cands[1].val) < cfg.closeCallGap) {
      const prevDeadline = lookaheadDeadline;
      lookaheadDeadline = Date.now() + cfg.depth3TimeBudgetMs;
      try {
        const [a, b] = cands;
        a.val3 = a.kind === 'play'
          ? playValue(defs, defs[a.cardId], posByHandIdx[a.handIdx], a.cardId, a.handIdx, state, depth + 1)
          : evaluateRedraw(defs, state, depth + 1, gs.hand.length);
        b.val3 = b.kind === 'play'
          ? playValue(defs, defs[b.cardId], posByHandIdx[b.handIdx], b.cardId, b.handIdx, state, depth + 1)
          : evaluateRedraw(defs, state, depth + 1, gs.hand.length);
        const applyEscalated = c => {
          if (c.kind === 'redraw') { redrawVal = c.val3; return; }
          const he = handEval.find(h => h.handIdx === c.handIdx);
          if (he) he.val = c.val3;
          if (bestPlay && bestPlay.handIdx === c.handIdx) {
            bestPlay.val = c.val3;
          } else if (!bestPlay || c.val3 > bestPlay.val) {
            const pos = posByHandIdx[c.handIdx];
            bestPlay = { val: c.val3, handIdx: c.handIdx, cardId: c.cardId,
              mana: defs[c.cardId].manaCost ?? 1, focus: pos.focus, moveCost: pos.moveCost,
              pHit: he ? he.pHit : undefined, ev: pos.ev };
          }
        };
        applyEscalated(a);
        applyEscalated(b);
        escalated = true;
      } catch (e) {
        if (!(e instanceof LookaheadBudgetExceeded)) throw e;
        // ran out of time -- abandon the escalation, keep the original depth-2 ranking untouched
      } finally {
        lookaheadDeadline = prevDeadline;
      }
    }
  }

  // HARDCODED RULE (user 2026-09-10, after an extensive live investigation): a hand card with ZERO
  // miss penalty that can be played at ZERO focus cost (no bobber movement needed) should never
  // lose to a redraw. Playing it costs strictly non-negative expected progress, reveals the exact
  // same regime information a redraw would (the fish moves regardless of which you choose), and you
  // can STILL redraw next turn -- at a CHEAPER cost, since your hand is now one card smaller -- if
  // the reduced hand looks weak. The investigation found the recursive engine can genuinely
  // undervalue this: a state built to dominate on every tracked resource (same mana, same focus,
  // strictly lower fishHp, one MORE observed move) scored WORSE than the alternative once real
  // recursion ran, traced to predict()'s regime classification behaving very differently depending
  // on how many moves have been observed (1 vs 2) rather than to any real difference in resources.
  // That's a real root-cause question for a future audit (flagged, not yet fixed) -- but this exact,
  // narrow scenario is safe to hardcode now rather than wait on it. Only overrides an ACTUAL redraw
  // decision -- if some OTHER card already legitimately beats both redraw and this free card, that
  // choice is untouched.
  const freeCards = Object.values(zeroCostByHandIdx).filter(z =>
    ((defs[z.cardId].missEffects || []).find(e => e.type === 'FISH_HP') || {}).amount === 0);
  if (freeCards.length && redrawVal > -Infinity && (!bestPlay || redrawVal > bestPlay.val)) {
    const best = freeCards.reduce((a, b) => (b.val > a.val ? b : a));
    const handIdx = +Object.keys(zeroCostByHandIdx).find(k => zeroCostByHandIdx[k] === best);
    log(`  forcing card ${best.cardId} over redraw (zero miss penalty, zero focus cost -- can still redraw next turn if needed)`);
    const forcedMv = { val: best.val, handIdx, cardId: best.cardId,
      mana: defs[best.cardId].manaCost ?? 1, focus: best.pos.focus, moveCost: 0,
      pHit: best.pHit, ev: best.pos.ev, forcedFreeCard: true };
    // Return directly rather than falling through to the value comparison below -- that
    // comparison is exactly what this rule exists to override (redrawVal is still numerically
    // higher than this card's own recursive value; that's the whole reason we're forcing it).
    return { type: 'play', mv: forcedMv, redrawVal, handEval, escalated };
  }

  if (!bestPlay && redrawVal === -Infinity) return { type: 'none', handEval };
  if (!bestPlay || redrawVal > bestPlay.val) return { type: 'redraw', val: redrawVal, playVal: bestPlay && bestPlay.val, handEval, escalated };
  return { type: 'play', mv: bestPlay, redrawVal, handEval, escalated };
}

/* ---- deck draft ----------------------------------------------------------------- */
function scoreCard(def) {
  const amt = t => (def[t] || []).reduce((s, e) => s + (e.type === 'FISH_HP' ? e.amount : 0), 0);
  const hit = amt('hitEffects'), miss = amt('missEffects'), crit = amt('critEffects');
  const cov = (def.hitZones || []).length, critN = (def.critZones || []).length;
  const mana = def.manaCost ?? 1;
  const plus = [2,4,6,8].every(z => (def.hitZones || []).includes(z));
  const s = hit * Math.min(cov, 4)
          + crit * critN * 0.4
          + (plus ? 6 : 0)
          + (cov >= 8 ? 4 : 0)
          + (miss === 0 ? 6 : 0)
          - Math.abs(miss) * 1.2;
  return s / Math.max(mana, 0.5); // guard: card 17 is manaCost 0 -- s/0 would be Infinity/NaN
}
function rankDraft(offered) {
  return offered.map((d, i) => ({ i, id: d.id, mana: d.manaCost ?? 1, hit: d.hitZones, crit: d.critZones,
    plus: [2,4,6,8].every(z => (d.hitZones || []).includes(z)), score: +scoreCard(d).toFixed(2) }))
    .sort((a, b) => b.score - a.score);
}
function findOfferedCards(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return null;
  if (Array.isArray(obj) && obj.length >= 2 && obj.length <= 4 && obj.every(x => x && x.hitZones && x.hitEffects)) return obj;
  for (const v of Object.values(obj)) { const f = findOfferedCards(v, depth + 1); if (f) return f; }
  return null;
}

/* ---- run loop ----------------------------------------------------------- */
// hitAmt/missAmt/critAmt: the raw catch-bar delta each outcome deals, straight from the API's own
// deckCardData (same fields effectAt() reads) -- was previously dropped, only zones were kept, so
// the run JSON (and the Bobber Replay viewer) had no way to show what a card's hit/miss/crit was
// actually worth without cross-referencing an external catalog.
const updateCards = (run, gs) => (gs.deckCardData || []).forEach(d => {
  const amt = arr => ((arr || []).find(e => e.type === 'FISH_HP') || {}).amount || 0;
  const hitAmt = amt(d.hitEffects), missAmt = amt(d.missEffects);
  run.cards[d.id] = { mana: d.manaCost ?? 1, hit: d.hitZones || [], crit: d.critZones || [],
    hitAmt, missAmt, critAmt: amt(d.critEffects) || hitAmt };
});

// fishBudget: how many MORE fish this call is allowed to play before stopping on a win (defaults
// to cfg.maxFish for any caller that doesn't pass one). Returns {result, fishPlayed} -- fishPlayed
// lets run() track a TOTAL across however many separate games it takes to reach the real target,
// since a loss/daycap can end a game after just one fish ("run N fish" means N total fish across
// as many games as needed, not "stop at the first loss").
async function playGame(n, fishBudget) {
  if (fishBudget == null) fishBudget = cfg.maxFish;
  let gs = await fetchState();
  const midFight = gs && gs.playerHp > 0 && gs.fishHp > 0 && gs.fishHp < gs.fishMaxHp && !(gs.cardsToAdd && gs.cardsToAdd.length);
  // A catch that got interrupted before loot() fired (e.g. cfg.maxTurns hit mid-catch, or the
  // process died) leaves the server with fishHp<=0 and a real, still-offered cardsToAdd -- calling
  // start_run against that state fails outright ("Player is already in a game"), because the catch
  // was never resolved. GET /state already returns everything the catch-handling branch below
  // needs (cardsToAdd, caughtFish) without a start_run response, so resume straight into the main
  // loop on THIS gs instead -- it hits the `gs.fishHp <= 0` branch on iteration 0 and loots/
  // continues normally. Confirmed live 2026-09-09: a 9-fish batch hit maxTurns=60 mid-catch,
  // leaving exactly this state; start_run then failed with a 400 until this fix resumed it.
  //
  // cardsToAdd alone isn't enough, though -- GET /state can keep echoing the same cardsToAdd
  // list even AFTER loot() already succeeded for this catch (confirmed live 2026-09-09: called
  // loot again on a state that still showed the 3 original options, got "Card already chosen").
  // gs.cardChosenId is the real signal for "already resolved" -- non-null means this catch's
  // draft is done and the account is just resting between fights (equivalent to no active game),
  // so fall through to a normal start_run instead of re-looting.
  const pendingDraft = gs && gs.fishHp <= 0 && gs.cardsToAdd && gs.cardsToAdd.length > 0 && gs.cardChosenId == null;
  let resp;
  if (midFight) log(`run ${n}: resuming in-progress fight`);
  else if (pendingDraft) log(`run ${n}: resuming pending draft (caught ${(gs.caughtFish && gs.caughtFish.name) || '?'}, not yet looted)`);
  else {
    log(`run ${n}: START node=${cfg.nodeId} tier=${cfg.tierId}`);
    // The daily catch cap isn't reliably readable client-side: dayDocs[pond].data.deck.length vs
    // maxPerDayJuiced looked like the gate, but the Jebaitor skill can proc on a cast so it
    // doesn't count against the cap -- confirmed live 2026-09-09, start_run kept succeeding with
    // the tally already OVER maxPerDayJuiced (23 caught vs a nominal cap of 20). The only genuine,
    // authoritative signal is the server's own rejection once the real limit is hit -- a distinct
    // error from "Player is already in a game" (which means an unresolved fight/draft, not a cap).
    try {
      resp = await action('start_run', { nodeId: cfg.nodeId, tierId: cfg.tierId });
    } catch (e) {
      if (/reached max runs/i.test(e.message)) {
        log(`  daily cap reached (server: "${e.message}") -- stopping cleanly, nothing more to catch today`);
        return { result: 'daycap', fishPlayed: 0 };
      }
      throw e;
    }
    gs = stateOf(resp);
  }

  const run = { meta: { node: cfg.nodeId, tier: cfg.tierId, result: null, fish: null,
                        fishMaxHp: gs.fishMaxHp, manaMax: gs.playerMaxHp, focusMax: gs.focusMeterMax,
                        canAlt: gs.fishMaxHp >= cfg.alternateMinHp,
                        canThree: gs.fishMaxHp >= cfg.threeMoveMinHp }, gridSize: G, cards: {}, turns: [] };
  updateCards(run, gs); lastRun = run;
  let oilBalance = cfg.useOils ? await fetchOilBalance(cfg.oilItemId) : 0;
  // moveLens: REAL step count per turn (gs.lastMovePath.length), parallel to hist -- needed so
  // predict() can correctly classify a 3-capable fish's regime from true step count rather than
  // net position delta (see predict()'s own comment; net delta alone can't tell a 3-step move
  // that doubled back from a genuine 1-step move). Reset alongside hist for each new fish.
  let hist = [gs.fishPosition.slice()], moveLens = [], fishNo = 1;
  log(`  fish#${fishNo} ${gs.fishHp}/${gs.fishMaxHp} | mana ${gs.playerHp}/${gs.playerMaxHp} | focus ${gs.focusMeter}/${gs.focusMeterMax} | fish@[${gs.fishPosition}] bobber@[${gs.focusPoint}] | hand=[${gs.hand}]`);

  for (let t = 0; t < cfg.maxTurns; t++) {
    if (stop) { run.meta.result = 'stopped'; return { result: 'stopped', fishPlayed: fishNo - 1 }; }

    if (gs.fishHp <= 0) {
      const offered = (gs.cardsToAdd && gs.cardsToAdd.length) ? gs.cardsToAdd : (findOfferedCards(resp) || []);
      const ranked = offered.length ? rankDraft(offered) : [];
      const pick = ranked[0];
      const last = run.turns[run.turns.length - 1];
      // jebaitorTriggered: a skill that can proc on a cast so it doesn't count against the daily
      // catch cap (maxPerDay/maxPerDayJuiced) -- confirmed live 2026-09-09: start_run succeeded
      // and caught a fish even after the day's tally read 21 against a maxPerDayJuiced of 20, so
      // that counter is NOT a reliable client-side predictor of "casts remaining" once Jebaitor is
      // in play. Recorded here (not decided on) purely so run data can show which catches were
      // free -- captured at the moment of catch, before any later action resets the field.
      if (last) {
        last.caught = gs.caughtFish && gs.caughtFish.name;
        last.jebaitorTriggered = !!gs.jebaitorTriggered;
        // Quality/rarity/sediment: real fields on the server's caughtFish object that were
        // captured all along in gs but only ever read .name -- confirmed live 2026-09-10 via a
        // raw GET /state dump (quality/rarity present, plus plusOneQuality/plusOneRarity/doubled
        // bonus flags, a findexResult "fish-dex" block, and seaweedEarned as the catch's currency
        // reward). User doesn't want the size/weight/length/girth fields; findexResult's
        // newLength/newGirth/newWeight are dropped too since they're the same size-record concept.
        // "seaweedEarned" renamed to "sediment" per user (2026-09-10) -- game calls it Seaweed,
        // user wants it displayed as Sediment.
        if (gs.caughtFish) {
          const cf = gs.caughtFish, fx = cf.findexResult || {};
          last.catchDetails = { quality: cf.quality, rarity: cf.rarity,
            plusOneQuality: !!cf.plusOneQuality, plusOneRarity: !!cf.plusOneRarity, doubled: !!cf.doubled,
            newFish: !!fx.newFish, newQuality: !!fx.newQuality, totalCaught: fx.totalCaught,
            sediment: cf.seaweedEarned };
        }
      }
      if (!run.meta.fish) run.meta.fish = gs.caughtFish && gs.caughtFish.name;
      const cd = last && last.catchDetails;
      const cdTxt = cd ? ` (quality ${cd.quality}, rarity ${cd.rarity}${cd.plusOneQuality ? ', +1 quality' : ''}${cd.plusOneRarity ? ', +1 rarity' : ''}${cd.doubled ? ', doubled' : ''}, +${cd.sediment || 0} Sediment)` : '';
      log(`  CAUGHT ${(gs.caughtFish && gs.caughtFish.name) || ''}!${cdTxt} draft [${offered.map(o => o.id)}] -> pick card ${pick ? pick.id : '(none)'}`);
      if (!pick) { run.meta.result = 'win'; log('  stopping (no draft)'); return { result: 'win', fishPlayed: fishNo }; }
      await sleep(cfg.delayMs);
      resp = await action('loot', { cards: [pick.id], nodeId: '', tierId: 0 });
      if (last) last.draft = { options: ranked.map(r => r.id), picked: pick.id };
      gs = stateOf(resp); updateCards(run, gs);
      if (fishNo >= fishBudget) { run.meta.result = 'win'; log(`  stopping (fish budget ${fishBudget} reached this game) — matches "Leave", no fight left active`); return { result: 'win', fishPlayed: fishNo }; }
      await sleep(cfg.delayMs);
      // Same daily-cap rejection as the initial start_run above can land here too -- the cap can be
      // hit mid-batch, right after looting a catch, not just at the very start of a run(). Missing
      // this try/catch meant a mid-batch cap-out surfaced as a raw "error: start_run failed 400 ..."
      // instead of the clean daycap stop, even though the outcome (stop, nothing more to catch) was
      // identical -- confirmed live 2026-09-09 when this exact path fired after catching Plankton.
      try {
        resp = await action('start_run', { nodeId: cfg.nodeId, tierId: cfg.tierId });
      } catch (e) {
        if (/reached max runs/i.test(e.message)) {
          run.meta.result = 'win';
          log(`  daily cap reached (server: "${e.message}") -- stopping cleanly, nothing more to catch today`);
          return { result: 'daycap', fishPlayed: fishNo };
        }
        throw e;
      }
      gs = stateOf(resp); updateCards(run, gs);
      fishNo++; hist = [gs.fishPosition.slice()]; moveLens = [];
      log(`  +added card ${pick.id}. fish#${fishNo} ${gs.fishHp}/${gs.fishMaxHp} | mana ${gs.playerHp} | fish@[${gs.fishPosition}] hand=[${gs.hand}]`);
      continue;
    }
    if (gs.playerHp <= 0)          { run.meta.result = 'loss'; return { result: lose(gs, 'out of mana'), fishPlayed: fishNo }; }
    if (gs.fishHp >= gs.fishMaxHp) { run.meta.result = 'loss'; return { result: lose(gs, 'catch bar emptied (fish escaped)'), fishPlayed: fishNo }; }

    const defs = {}; (gs.deckCardData || []).forEach(d => defs[d.id] = d);
    const pr = predict(hist, { canAlternate: gs.fishMaxHp >= cfg.alternateMinHp,
      canThree: gs.fishMaxHp >= cfg.threeMoveMinHp, moveLens, telegraph: gs.nextPosition });
    const choice = chooseAction(gs, hist, pr, cfg.enableRedraw);
    const mv = choice.mv;
    const candStr = pr.exact ? `predict [${pr.cand[0].cell}] (${pr.why})` : `${pr.cand.length} cells (${pr.why})`;
    await sleep(cfg.delayMs);

    if (choice.type === 'redraw' || choice.type === 'none') {
      const cost = (gs.hand || []).length;
      const snap = { n: t, action: 'redraw', hand: (gs.hand || []).slice(), redrawCost: cost,
        fishBefore: gs.fishPosition.slice(), bobberFrom: gs.focusPoint.slice(), bobber: gs.focusPoint.slice(), moveCost: 0,
        predicted: pr.cand.map(c => c.cell), predictedExact: pr.exact, why: pr.why, card: null, covered: [], critCells: [],
        result: 'redraw', manaBefore: gs.playerHp, focusBefore: gs.focusMeter, fishHpBefore: gs.fishHp, fishMaxHp: gs.fishMaxHp,
        drawPool: gs.fullDeck ? drawPool(gs) : undefined, choiceVal: choice.val, playVal: choice.playVal, handEval: choice.handEval };
      log(`  t${t}: ${candStr} -> REDRAW (discard ${cost}, -${cost} mana)`);
      resp = await action('play_cards', { cards: [], focusPoint: gs.focusPoint });
      { const before = hist[hist.length - 1]; gs = stateOf(resp); hist.push(gs.fishPosition.slice());
        moveLens.push(gs.lastMovePath ? gs.lastMovePath.length : man(before, gs.fishPosition)); }
      Object.assign(snap, { fishAfter: gs.fishPosition.slice(), lastMovePath: gs.lastMovePath, fishHp: gs.fishHp, mana: gs.playerHp, focus: gs.focusMeter });
      run.turns.push(snap);
      log(`     redrew -> fish->[${gs.fishPosition}] fishHp ${gs.fishHp} mana ${gs.playerHp} hand=[${gs.hand}]`);
      continue;
    }

    const def = defs[mv.cardId] || {};
    const snap = { n: t, action: 'play', hand: (gs.hand || []).slice(), playedHandIdx: mv.handIdx,
      fishBefore: gs.fishPosition.slice(), bobberFrom: gs.focusPoint.slice(), bobber: mv.focus.slice(),
      predicted: pr.cand.map(c => c.cell), predictedExact: pr.exact, why: pr.why,
      card: { id: mv.cardId, mana: mv.mana, hit: def.hitZones || [], crit: def.critZones || [] },
      covered: coveredCells(def.hitZones || [], mv.focus[0], mv.focus[1]),
      critCells: coveredCells(def.critZones || [], mv.focus[0], mv.focus[1]),
      moveCost: mv.moveCost, ev: +mv.ev.toFixed(2), pHit: +(mv.pHit || 0).toFixed(2),
      manaBefore: gs.playerHp, focusBefore: gs.focusMeter, fishHpBefore: gs.fishHp, fishMaxHp: gs.fishMaxHp,
      drawPool: gs.fullDeck ? drawPool(gs) : undefined, choiceVal: mv.val, redrawVal: choice.redrawVal, handEval: choice.handEval };
    log(`  t${t}: ${candStr} -> card ${mv.cardId} @bobber[${mv.focus}] (move ${mv.moveCost}f) pHit ${((mv.pHit || 0) * 100).toFixed(0)}%`);

    // Big Dual Yield Oil: only spend it the turn a catch looks imminent AND likely (per user
    // 2026-09-10) -- "potential catch" means this exact play's hit effect would zero the catch
    // bar outright (fishHp <= this card's hitAmt), not merely a high-EV turn. Checked against the
    // SAME hitAmt field guaranteedCatch/leafEstimate already use elsewhere in this file.
    if (cfg.useOils && oilBalance > 0 && (mv.pHit || 0) >= cfg.oilPHitThreshold) {
      const hitAmt = (def.hitEffects && def.hitEffects.find(e => e.type === 'FISH_HP') || {}).amount || 0;
      const potentialCatch = hitAmt > 0 && (gs.fishHp - hitAmt) <= 0;
      const freeSlot = (gs.fishingConsumableSlotUsed || [false, false, false]).findIndex(u => !u);
      if (potentialCatch && freeSlot !== -1) {
        log(`     using Big Dual Yield Oil before likely catch (pHit ${((mv.pHit || 0) * 100).toFixed(0)}%, ${oilBalance} left)`);
        try {
          const oilResp = await action('use_fishing_item', { itemId: cfg.oilItemId, slotIndex: freeSlot, tierId: cfg.oilTierId });
          gs = stateOf(oilResp); oilBalance--; snap.oilUsed = cfg.oilItemId;
        } catch (e) { warn('oil use failed:', e.message); }
      }
    }
    resp = await action('play_cards', { cards: [mv.handIdx], focusPoint: mv.focus });
    // The server never actually emits a CRIT event (only HIT or nothing) -- eventsOf() looking
    // for one silently mislabeled every real crit as a plain HIT. Crit damage was never wrong
    // (effectAt() already computes it correctly for prediction), just the LOGGED/RECORDED label.
    // Determine it directly from the fish's actual post-move cell against this card's own
    // critZones/hitZones (the same authoritative zone math effectAt() uses), not the event list.
    const newGs = stateOf(resp);
    const inZone = zones => (zones || []).some(z => { const c = zoneCell(z, mv.focus[0], mv.focus[1]); return c[0] === newGs.fishPosition[0] && c[1] === newGs.fishPosition[1]; });
    const kind = inZone(def.critZones) ? 'CRIT' : inZone(def.hitZones) ? 'HIT' : 'miss';
    { const before = hist[hist.length - 1]; gs = newGs; hist.push(gs.fishPosition.slice());
      moveLens.push(gs.lastMovePath ? gs.lastMovePath.length : man(before, gs.fishPosition)); }
    Object.assign(snap, { result: kind, fishAfter: gs.fishPosition.slice(), lastMovePath: gs.lastMovePath, fishHp: gs.fishHp, mana: gs.playerHp, focus: gs.focusMeter });
    run.turns.push(snap);
    log(`     ${kind} | ${bar(gs)} | mana ${gs.playerHp} | focus ${gs.focusMeter} | fish->[${gs.fishPosition}] path=${JSON.stringify(gs.lastMovePath)} hand=[${gs.hand}]`);
  }
  run.meta.result = 'turn-cap';
  return { result: 'turn-cap', fishPlayed: fishNo - 1 };
}
const lose = (gs, why) => (log(`  lost: ${why} (${bar(gs)}, mana ${gs.playerHp})`), 'loss');

// onGameDone(run, gameNo): optional, called right after EACH completed game with that game's own
// run object -- NOT a default side effect of run() itself (test-run.js calls FB.run() directly
// against a mocked network and must never touch the real filesystem). The CLI entry point below
// is the only caller that passes exportRun here, so only a real CLI invocation ever writes files.
//
// "run N fish" means N fish TOTAL, across however many separate start_run games it takes -- a
// loss (or daycap, or anything else) ends the CURRENT game, but never the batch itself: don't stop
// at the first loss, keep going until the real target is met. cfg.maxGames is an optional extra
// safety cap on the number of games attempted (null/unset = uncapped -- the daily-cap rejection
// and the fish-total itself are the real backstops); most users never need to set it.
async function run(onGameDone) {
  stop = false; log('start. Ctrl+C to stop');
  const out = [];
  let remaining = cfg.maxFish, g = 0;
  while (remaining > 0 && !stop) {
    g++;
    if (cfg.maxGames != null && g > cfg.maxGames) {
      log(`  reached maxGames (${cfg.maxGames}) safety cap with ${remaining} fish still short of the target -- stopping`);
      break;
    }
    let outcome;
    try {
      outcome = await playGame(g, remaining);
    } catch (e) { warn('error:', e.message); out.push('err'); break; }
    out.push(outcome.result);
    remaining -= outcome.fishPlayed;
    // lastRun (and therefore exportRun(), which just reads it) only ever holds the MOST RECENT
    // playGame() call's data -- with multiple games in one batch every earlier game used to be
    // silently overwritten and never saved. Calling onGameDone here, once per completed game, is
    // what actually fixes it -- exporting once after the whole loop can only see the last one.
    if (onGameDone) onGameDone(lastRun, g);
    if (outcome.result === 'daycap') { log('  stopping: daily cap reached, no more games possible today'); break; }
    await sleep(cfg.delayMs);
  }
  log('done:', out.join(', '));
  return out;
}

function exportRun() {
  if (!lastRun) { warn('no run recorded yet'); return null; }
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  const file = path.join(RUNS_DIR, `run-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(lastRun));
  log('run JSON written to ' + file);
  return lastRun;
}

// Interactively asks whether/how to use fishing oils THIS run. Oils spend real, limited account
// inventory, so this is deliberately opt-in each time rather than a silent standing decision --
// only called from the CLI entry point below, never when run()/playGame() are used as a library
// (tests, sim.js) or when any oil flag was already given on the command line (`already` below).
async function promptForOilConfig(already) {
  if (already) { log(`oils: using command-line flags (useOils=${cfg.useOils})`); return; }
  if (!process.stdin.isTTY) {
    log('oils: non-interactive session, no --useOils flag given -- leaving oils off (use --useOils=true --oilItemId=... to enable without a prompt)');
    return;
  }
  const rl = require('readline/promises').createInterface({ input: process.stdin, output: process.stdout });
  try {
    const useAns = (await rl.question('Use fishing oils this run? [y/N]: ')).trim().toLowerCase();
    if (useAns !== 'y' && useAns !== 'yes') { log('oils: off for this run'); return; }
    const idAns = (await rl.question(`Which item id to use? [${cfg.oilItemId} = Big Dual Yield Oil]: `)).trim();
    if (idAns) cfg.oilItemId = +idAns;
    const thrAns = (await rl.question(`Minimum hit chance before using it, 0-1 [${cfg.oilPHitThreshold}]: `)).trim();
    if (thrAns) cfg.oilPHitThreshold = +thrAns;
    cfg.useOils = true;
    log(`oils: ON this run -- itemId=${cfg.oilItemId}, only when hit chance >= ${cfg.oilPHitThreshold} and it would land the catch outright`);
  } finally {
    rl.close();
  }
}

/* ---- CLI entry point ------------------------------------------------------------ */
if (require.main === module) {
  const args = {};
  // Only coerce plain decimal numbers (e.g. --maxFish=3). Unary `+` also parses hex strings
  // ("0x...") as numbers, so the naive `isNaN(+m[2])` check silently corrupted any
  // --address=0x... into a huge float -- a real bug, caught by testing the new --tokenFile/
  // --address flags before relying on them, not by inspection.
  const isPlainDecimal = s => /^-?\d+(\.\d+)?$/.test(s);
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([\w]+)=(.+)$/);
    if (m) args[m[1]] = isPlainDecimal(m[2]) ? +m[2] : m[2];
  }
  const oilFlagGiven = ['useOils', 'oilItemId', 'oilTierId', 'oilPHitThreshold'].some(k => k in args);
  Object.assign(cfg, args);
  if (!cfg.address) {
    console.error('[FishBot] No --address given (and cfg.address is unset). Pass your wallet address, e.g.:\n' +
      '  node fishbot-node.js --maxFish=1 --address=0xYOUR_WALLET\n' +
      'See README.md for how to find your address and set up token.txt.');
    process.exit(1);
  }
  process.on('SIGINT', () => { stop = true; log('stopping...'); });
  promptForOilConfig(oilFlagGiven)
    .then(() => run(exportRun))
    .catch(e => { warn('fatal:', e.message); process.exit(1); });
}

module.exports = { run, stop: () => { stop = true; }, config: o => Object.assign(cfg, o),
  rankDraft, scoreCard, exportRun, getRun: () => lastRun, cfg,
  _predict: predict, _decide: decide, _shouldRedraw: shouldRedraw, _drawPool: drawPool, _effectAt: effectAt, _reachable: reachable, _reachableWeighted: reachableWeighted, _zoneCell: zoneCell,
  _chooseAction: chooseAction, _lookaheadValue: lookaheadValue, _bestPositionFor: bestPositionFor, _positionsFor: positionsFor, _evaluateRedraw: evaluateRedraw, _combos: combos, _playValue: playValue };
