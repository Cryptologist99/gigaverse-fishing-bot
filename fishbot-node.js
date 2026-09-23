#!/usr/bin/env node
/* ============================================================================
 * Gigaverse Fishing Bot — standalone Node CLI (calls the API directly, no browser).
 * ----------------------------------------------------------------------------
 * Same decision engine as fishbot.js (predict / positionsFor / lookahead / chooseAction),
 * ported to run outside the page: jwt() reads from token.txt instead of localStorage,
 * exportRun() writes a JSON file instead of using the clipboard.
 *
 * token.txt must hold the raw JWT (paste from the browser's localStorage authResponse.jwt —
 * DevTools console: copy(JSON.parse(localStorage.getItem('authResponse')).jwt), then save the
 * clipboard contents into token.txt). Re-paste it here whenever the token expires (401s).
 *
 * Running against a DIFFERENT account: create a second token file yourself the same way (e.g.
 * token-main.txt, in this directory), then pass --tokenFile and --address to point at it —
 * neither of these ever asks for or touches the JWT value itself.
 *
 * Usage:
 *   node fishbot-node.js --maxFish=1
 *   node fishbot-node.js --maxFish=5
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
  address:  '0x7f9Dc44Ec4EE1E8ccaC4AE04Fd541e4acE0E4942',
  tokenFile: null, // path (relative to this file's dir, or absolute) to a JWT file, for running
                    // against an account other than the default -- overrides TOKEN_PATH below when
                    // set. The user creates this file themselves (paste the JWT into it directly,
                    // same as token.txt) -- never pass a JWT value on the command line or in chat.
  nodeId:   '5', tierId: 1, itemId: 0, slotIndex: 0,
  // Auto-repair (and auto-Restore, once repairs are maxed) equipped gear at 0 durability before
  // the next cast -- see checkAndRepairGear. Defaults ON, unlike oils/tier2-3 rings -- user
  // explicitly directed this as standing behavior 2026-09-23 ("check before every cast"), not an
  // opt-in-per-run action.
  autoRepairGear: true,
  // If a needed Restore can't be afforded (see computeMaterialShortfall), the default is to STOP
  // the whole batch cleanly (throws, same fatal-error path as "Not enough energy") so the user can
  // decide -- user-directed 2026-09-23. Set this true to instead just warn and keep fishing with
  // that item still at 0 durability, un-restored -- an explicit opt-in for "I know, let it ride."
  continueOnBrokenGear: false,
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
  // OFF by default (2026-09-10, per user): using an oil spends real limited inventory on the
  // user's actual account, so the CLI now asks interactively each run rather than silently
  // deciding on its own -- see promptForOilConfig() below, called from the CLI entry point only
  // (never from library/test usage of run()/playGame()). Passing --useOils=true (or any of the
  // oil flags) on the command line skips the prompt and uses the flag values directly, for
  // scripted/non-interactive use.
  useOils: false, oilItemId: 972, oilTierId: 0, oilPHitThreshold: 0.75,
  // maxFish is a TOTAL across as many separate games as it takes (2026-09-10 change) -- a loss
  // ends the current game, not the batch; run() keeps starting new games until maxFish total fish
  // have been played or the daily cap is hit. maxGames is now just an optional extra safety cap on
  // game count (null = uncapped); most users never need it. See run()'s own comment for the reasoning.
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
  riskAversionWeight: 0.5, // MEASURED 2026-09-14, user-directed investigation. The recursive
                     // win-probability search was picking a genuinely weak card (e.g. 10% pHit)
                     // over a clearly stronger one sitting in the SAME hand (e.g. 50% pHit) --
                     // confirmed live in two real casts (#349 T5: card80 10% chosen over card88
                     // 50%; #381 T1: card110's 17% crit-only gamble chosen over card108's 37.5%)
                     // -- and mining every real turn's logged handEval found this wasn't a rare
                     // fluke: 88 real turns confidently (>0.02 val gap) preferred a card >=15pp
                     // worse on pHit, and fish that did this lost far more than fish that didn't,
                     // band-for-band (low 79.6% vs 92.0% win, mid 70.0% vs 77.8%, high 36.8% vs
                     // 94.4%) -- consistent direction in all three bands, though correlational.
                     // User's diagnosis: the raw win-probability math already prices a miss's
                     // catch-bar cost, but not the EXTRA risk of betting against the odds, nor
                     // the extra value of a hit that leaves you playing from a stronger position.
                     // riskAdjust() subtracts this weight times a play's own P(miss) -- but ONLY
                     // when RANKING candidate plays against each other (see the three call sites
                     // below); the value that feeds the play-vs-redraw decision, recursion, and
                     // logging is always the TRUE undiscounted number. That scoping was itself a
                     // real fix, not just style: an earlier version applied the discount directly
                     // to playValue()'s returned number, which then ALSO fed the redraw decision --
                     // this pushed redraw rate up ~30% (280->363 of 863 real turns) and made
                     // progress-per-mana measurably WORSE in every band (1.762->1.534 overall),
                     // because it was discouraging plays broadly rather than specifically
                     // preferring a reliable play over a risky one when both were available.
                     // Rescoped to a pure ranking tiebreak (this version): all 104 unit tests
                     // pass, play/redraw counts stay ~flat vs baseline (583/280 -> 589/274 of 863
                     // real turns), hit-rate rose 72.2%->76.1%, and -- the metric that actually
                     // matters, since mana is the hard constraint the game imposes -- catch-bar
                     // progress per mana spent rose 1.762->1.931 (+9.6%), holding in every HP band.
                     // 0.5 was chosen from a weight sweep (0, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.7, 1
                     // on a 166-turn sample, confirming the top two candidates on the full
                     // 863-turn sample): progress/mana rose smoothly to a peak at 0.5 then fell
                     // back by 0.7-1.0, so this is a real peak, not a monotonic "more is better".
                     // All measurements above are OFFLINE per-turn replay against real historical
                     // casts (see replay-efficiency2.js / sweep.js in the session scratchpad, not
                     // committed to this repo) -- not yet validated with a live run. Those replays
                     // ran with closeCallGap:0 (depth-3 escalation OFF) for speed/determinism, so
                     // they don't cover the interaction documented at the escalation block below --
                     // that fix is necessary for correctness (escalation was capable of silently
                     // undoing this whole feature) but its effect on the measured numbers above is
                     // unverified, since escalation only fires on already-close top-2 calls.
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

  // 2026-09-22 audit (n=4029 real turns, pooled across every recorded live game, all fish sizes):
  // leafEstimate's old affordability math (mana / playsNeeded) implicitly assumed every mana point
  // buys a PLAY -- it had zero model of redraws, which are a real, roughly constant ~35% of all
  // turns regardless of fish size (measured 32.8%-37.2% across HP bands, not meaningfully
  // fish-size-dependent, so this is a single pooled constant rather than a per-band one).
  // Investigated live because 28-30hp losses looked redraw-heavy in a small sample (n=5), but that
  // didn't replicate at scale (n=50: losses actually had a LOWER redraw rate than same-band wins,
  // 27.5% vs 35.3% -- the small sample was noise). What DOES hold at scale: winning 28-30hp fights
  // already spend close to the full 14-mana budget in the tail (p95 mana-used == 14, 25.3% of wins
  // use >=12/14) -- so this band's budget has little real slack, and ANY unmodeled tax shrinks an
  // already-thin margin. Since redraw rate is ~constant per TURN but big fish need more total turns,
  // the absolute mana this omission misses scales with turns-needed even though the rate doesn't --
  // exactly the mechanism the user's intuition pointed at, just not visible in the raw redraw-rate
  // comparison. These three constants (measured, not fit): redrawRateEstimate = fraction of all
  // turns that are redraws; avgRedrawManaCost = mean mana cost of a redraw turn (~= mean hand size
  // at redraw time); avgPlayManaCost = mean mana cost of a play turn (~1, most cards cost 1). See
  // leafEstimate() for how these combine into an amortized effective mana-cost-per-play.
  redrawRateEstimate: 0.351,
  avgRedrawManaCost: 2.377,
  avgPlayManaCost: 0.924,
  redrawPlaysBuffer: 0,
  alternateMinHp: 21, // CONFIRMED by user 2026-09-09: 21-HP fish themselves CAN alternate (not just
                       // fish strictly above 21) -- do not raise this to 22. The 2026-09-09 audit's
                       // sample of 21-HP fish (n=8, all locked always-X after 1 move) undersampled
                       // true alternators at exactly 21; this is a settled game-mechanics fact, not
                       // a statistical judgment call.
  alternateContinuationPrior: 0.75, // SUPERSEDED 2026-09-13 by moveDistPrior[band].cont, which
                       // measures this per HP band instead of using one number for every fish size.
                       // Kept only as the fallback when a caller supplies neither fishMaxHp nor a
                       // recognizable band. History: measured live 2026-09-06 (5 of 6 canAlt fish
                       // locked into always-X after their first move) and re-checked 2026-09-09
                       // (n=12 fish >=21hp, 10/12 same). Both samples were dominated by small fish,
                       // which is why they read high -- see moveDistPrior for the split.
  threeMoveMinHp: 28, // CONFIRMED live 2026-09-10 (user): fish at 29hp+ can take a 3-STEP move in
                       // one turn (30hp confirmed too). LOWERED to 28 on 2026-09-13 after a live
                       // 28hp fish ("Gulp") showed a clean, real, fully regular 1<->3 alternation
                       // across 6 real turns (lastMovePath lengths exactly [3,1,3,1,3,1], not net
                       // displacement -- see below). The real signal is PATH LENGTH
                       // (lastMovePath.length), not net Manhattan displacement -- a 3-step path can
                       // double back and land only 1 or 2 squares from start (mathematically, 3
                       // orthogonal unit steps can only ever net to 1 or 3, never 0 or 2 -- parity:
                       // an even net in each axis needs an even step count on that axis, and two
                       // even counts can't sum to the odd total of 3). Confirmed against real
                       // history: fishMaxHp 28 and 29 are the only sizes that ever show a 3-length
                       // path; every other size (14-30 except 28/29) never does. NOT every fish
                       // >=28hp uses it, though -- only 3 of 10 real 28-29hp fish encounters showed
                       // any 3-step move at all; the rest were ordinary always-1/always-2/
                       // alternating-1-2, identical to smaller fish. Every confirmed 3-capable fish
                       // locked into a clean, perfectly regular alternation once measured by path
                       // length: 1<->3 (seen twice) or 2<->3 (seen once) -- never all three, never a
                       // fixed "always-3". Sample size is still small (3 real 3-capable fish, vs. the
                       // dozens that established alternateMinHp) -- revisit thresholds/priors below
                       // as more real fish confirm or complicate this, especially whether 27hp or
                       // below can ever show it too.
  threeMoveContinuationPrior: 0.75, // SUPERSEDED 2026-09-13 by moveDistPrior.high.cont (measured
                       // 0.58, n=66). Kept only as a fallback; see alternateContinuationPrior.
  // ---- moveDistPrior: what distance will the fish move next? -------------------------------
  // Measured 2026-09-13 over the full 342-cast replay set (1,734 real moves). Move length is
  // ALWAYS lastMovePath.length, never net displacement (see threeMoveMinHp on why that matters).
  // Bands: low = <=21hp, mid = 22-27hp, high = >=threeMoveMinHp.
  //
  // This replaces TWO guesses, both of which were materially wrong:
  //
  // 1. The turn-0 opening belief used to be a raw union of the dist-1/2/3 candidate sets, summed
  //    WITHOUT normalizing each distance to its own total. Because a 3-step walk has ~5x as many
  //    distinct paths as a 1-step one, raw path count silently handed d=3 roughly 59-63% of the
  //    opening belief on every >=28hp fish -- against a MEASURED 5% real rate. Same bug, milder,
  //    for d=2 vs d=1 (71%/29% assigned vs ~50/50 measured). Each branch is now normalized to
  //    its own total first, then scaled by `first` below, so extra paths no longer buy belief.
  //
  // 2. The one-move-observed continuation prior was a flat 0.75 for every fish. Measured, it is
  //    strongly size-dependent: small fish lock into a fixed always-X regime essentially always,
  //    while big fish are close to a coin flip on each move.
  //      <=21hp:  first transition repeated the same distance 240/240 = 100%
  //               (counted per FISH, not per transition -- transitions within one fish are
  //               NOT independent: an alternator switches on every one, a non-alternator on
  //               none, so a transition count inflates the evidence ~3x. 0 alternators in
  //               157 fish with >=4 moves; 95% upper bound on P(alternating) ~1.9%.)
  //      22-27hp: 22/42 = 52%
  //      >=28hp:  38/66 = 58%
  //
  // Backtested over the 680 real turns these priors actually touch (0 or 1 observed moves;
  // >=2 moves still uses the exact regime detection below, which is unchanged). Probability
  // assigned to the cell the fish really moved to: low 0.3187 -> 0.3181 (flat), mid 0.1355 ->
  // 0.1554 (+14.7%), high 0.1012 -> 0.1418 (+40.1%), overall +13.3%; top-1 accuracy on >=28hp
  // fish 18.9% -> 25.8%. Holds out of sample: priors fitted on casts 1-171 and scored on the
  // held-out casts 172-342 give +33.4% on the high band, +11.7% overall.
  moveDistPrior: {
    // first:null => keep the legacy raw path-count union at turn 0 for this band. Deliberate:
    // flattening the low band to 0.50/0.50 was worth +2.9% probability mass but COST 4.6 points
    // of top-1 accuracy (33.8% -> 29.2%), i.e. at short range the path-count skew is picking up
    // a real within-grid landing bias that a flat prior throws away. Only mid/high use `first`.
    low:  { first: null,                          cont: 0.97 },
    mid:  { first: { 1: 0.50, 2: 0.50, 3: 0    }, cont: 0.55 },
    high: { first: { 1: 0.50, 2: 0.45, 3: 0.05 }, cont: 0.55 },
  },
  // Upper HP bound of the "low" band. NOT the same as alternateMinHp (21), and the difference is
  // deliberate: the user confirmed 2026-09-09 that 21hp fish CAN alternate, so canAlt stays true
  // at 21 and we keep hedging -- but not one ever has, in any logged cast (31 at exactly 21hp in
  // the replay set, 33 counting segmented run files; band-wide, 0 alternators in 157 <=21hp fish with >=4 moves (enough to tell), 0 in all 240 with >=2 moves),
  // so the hedge is 3% via low.cont=0.97 -- above the ~1.9% upper bound, deliberately generous
  // rather than the 25% a flat 0.75 was spending. Both facts can hold at once if alternation is
  // gated on something rarer than HP (quality is the obvious candidate -- q1 fish are exactly the
  // 14-21hp range), so this narrows the hedge without asserting 21hp fish never alternate.
  moveBandLowMaxHp: 21,
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
  // make the decision worse or block play past this budget. This is pure local CPU time, no API/LLM
  // cost, so the only real tradeoff is turn latency during a live run.
  //
  // Raised 15000 -> 90000 (user, 2026-09-19, explicit: prioritize decision quality over turn
  // latency "more than we have been"). Immediate cause: the closeCallGap fix shipped the same day
  // (see fishing-notes.md) made escalation correctly TRIGGER on a real losing cast's play-vs-redraw
  // call that it had silently never triggered on before (a gap-check scale bug) -- but that specific
  // case needed ~59s uncapped to actually finish, well past the old 15s budget, so it triggered,
  // timed out, and fell back to the same wrong answer anyway. 90s covers that case with headroom
  // without reaching for the 443s worst-case tail. Turn snapshots now record `escalated` /
  // `escalationAttempted` / `escalationTimedOut` (previously untracked) specifically so this number
  // can be revisited from real frequency/timeout data instead of a single example once enough live
  // casts have run under it.
  depth3TimeBudgetMs: 90000,

  // --- draft/card-selection knobs (2026-09-12, see scoreCard/rankDraft) ---------------------
  // Small additive nudge toward drafting a card that covers board zones the current deck is
  // thin on, WITHOUT penalizing a duplicate of an already-strong card (user's explicit call:
  // duplicates of strong cards are fine) -- static scores typically range roughly -6 to +20, so
  // this is deliberately small enough to only break near-ties, never override a real quality gap.
  draftDeckAwareWeight: 3,
  // Minimum number of real, playable handEval samples (from actually-logged turns across
  // runs/*.json) a card needs before its empirical average value is trusted as a draft-score
  // multiplier -- below this it's noise, so scoreCard() falls back to the static heuristic alone.
  empiricalMinSamples: 8,
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
// Cached once per process (see run()) rather than re-scanned on every draft -- loadEmpiricalPriors()
// reads every file under runs/, which only needs to happen once per CLI invocation.
let empiricalPriorsCache = null;
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
// only works via the bot's own token, same as fetchState()/action(). Generic (any itemId), not
// oil-specific despite the original name -- reused for gear-restore material checks below.
async function fetchItemBalance(itemId) {
  const res = await fetch('https://gigaverse.io/api/items/balances', { headers: { 'Authorization': 'Bearer ' + jwt() } });
  const j = await res.json().catch(() => ({}));
  const e = (j.entities || []).find(x => String(x.ID_CID) === String(itemId));
  return e ? e.BALANCE_CID : 0;
}

// --- gear durability (2026-09-23, user-directed) --------------------------------------------
// Also outside the fishing namespace, same Bearer-token auth pattern as fetchItemBalance.
// gear/items is the static catalog (name, rarity, REPAIR_COUNT_CID = max repairs allowed before
// a reset/Restore is required -- confirmed 5 for Head/Body armor, 3 for Ring/Rod/Lure, NOT a flat
// 3 for everything). gear/instances is the account's actual owned gear, keyed by docId, with
// DURABILITY_CID (current) and REPAIR_COUNT_CID (repairs already used on THIS instance -- same
// field name as the catalog's max, different meaning, don't confuse the two).
let gearItemsCatalogCache = null;
async function fetchGearItemsCatalog() {
  if (gearItemsCatalogCache) return gearItemsCatalogCache;
  const res = await fetch('https://gigaverse.io/api/gear/items', { headers: { 'Authorization': 'Bearer ' + jwt() } });
  const j = await res.json().catch(() => ({}));
  gearItemsCatalogCache = j.entities || j || [];
  return gearItemsCatalogCache;
}
async function fetchGearInstances() {
  const res = await fetch('https://gigaverse.io/api/gear/instances/' + cfg.address, { headers: { 'Authorization': 'Bearer ' + jwt() } });
  const j = await res.json().catch(() => ({}));
  return j.entities || [];
}
// POST /api/gear/repair and /api/gear/restore -- discovered live 2026-09-23 via browser network
// capture + trial payloads. Both need gearInstanceId (the exact docId) -- an empty body 500s with
// "Gear instance not found" (confirmed), so this is NOT an "operate on whatever's equipped"
// endpoint; it targets one specific instance.
async function repairGear(gearInstanceId) {
  const res = await fetch('https://gigaverse.io/api/gear/repair', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + jwt(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ gearInstanceId })
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('repair failed ' + res.status + ' ' + (j.message || JSON.stringify(j)));
  return j;
}
// Restore rerolls the item's rarity (can go up, down, or stay the same, confirmed live: a Rare
// Twin Lure rolled down to Common) -- a real gamble on top of spending Gear Ember, not a neutral
// reset. User-directed 2026-09-23: auto-restore IS wanted once repairs are maxed (unlike the
// earlier, more cautious "warn only" version of this code), but ONLY when the required materials
// are actually in stock -- see checkAndRepairGear's material check below, which throws (stopping
// the batch cleanly) rather than silently skipping when they're not.
async function restoreGear(gearInstanceId) {
  const res = await fetch('https://gigaverse.io/api/gear/restore', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + jwt(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ gearInstanceId })
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('restore failed ' + res.status + ' ' + (j.message || JSON.stringify(j)));
  return j;
}
// Material id -> display name, extracted from the game's own frontend catalog (no live endpoint
// exposes this -- same technique as fish-catalog.json, see fishing-notes.md). Only for readable
// log/error text; never used for any decision logic.
const MATERIAL_NAMES = { 7: 'Ethereal Thread', 21: 'Wood', 22: 'Fiber', 23: 'Bone', 133: 'Transfuser', 200: 'Glass Orb', 250: 'Gear Ember' };
// Pure decision logic (no network) so this is unit-testable offline -- see test.js. Only equipped
// items at EXACTLY 0 durability are actionable; anything above 0 is left alone regardless of how
// low it is, matching the user's explicit rule (repair/restore only triggers at 0, never earlier).
// needsRestore carries the Restore material cost (resetInputs/resetAmounts) so the caller can check
// affordability before spending anything.
function decideGearActions(instances, catalog) {
  const catalogById = {}; (catalog || []).forEach(c => catalogById[c.GAME_ITEM_ID_CID] = c);
  const toRepair = [], needsRestore = [];
  for (const inst of (instances || [])) {
    if (inst.EQUIPPED_TO_SLOT_CID === -1 || inst.EQUIPPED_TO_SLOT_CID == null) continue;
    if (inst.DURABILITY_CID !== 0) continue;
    const cat = catalogById[inst.GAME_ITEM_ID_CID];
    const maxRepairs = cat ? cat.REPAIR_COUNT_CID : null;
    const usedRepairs = inst.REPAIR_COUNT_CID || 0;
    const name = cat ? cat.NAME_CID : ('item ' + inst.GAME_ITEM_ID_CID);
    if (maxRepairs != null && usedRepairs >= maxRepairs) {
      const rc = (cat && cat.repairCost) || {};
      needsRestore.push({ docId: inst.docId, name, usedRepairs, maxRepairs,
        resetInputs: rc.RESET_INPUT_ID_CID_array || [], resetAmounts: rc.RESET_INPUT_AMOUNT_CID_array || [] });
    } else toRepair.push({ docId: inst.docId, name, usedRepairs, maxRepairs });
  }
  return { toRepair, needsRestore };
}
// Pure too (no network) -- given the materials a Restore needs (parallel id/amount arrays) and
// the account's current balance for each (same order), returns which ones fall short. Empty
// result means affordable. Separated out from checkAndRepairGear so this comparison itself is
// unit-testable -- see test.js.
function computeMaterialShortfall(resetInputs, resetAmounts, balances) {
  return resetInputs
    .map((id, i) => ({ id, need: resetAmounts[i], have: balances[i] }))
    .filter(x => x.have < x.need);
}
// Called right before every start_run (both the very first fish of a game and each subsequent
// fish in the same chain -- see playGame()) so a durability hit mid-batch gets repaired/restored
// before the NEXT cast, not just at the top of a batch. cfg.autoRepairGear defaults on since the
// user directed this as standing behavior, not an opt-in-per-run action like oils/tier2-3 rings.
//
// Repair failures are non-fatal (warn and move on -- the same item just gets re-checked next
// cast). Restore is different: if the required materials aren't in stock, this THROWS instead of
// silently skipping, which propagates up through playGame()/run()'s existing fatal-error handling
// (same path as "Not enough energy" etc.) -- stops the batch cleanly, exports whatever was caught
// so far, and surfaces a clear reason. User-directed 2026-09-23: "stop and ask" rather than either
// continuing to fish with broken gear or guessing what to do about missing materials.
async function checkAndRepairGear() {
  if (!cfg.autoRepairGear) return;
  let instances, catalog;
  try {
    [instances, catalog] = await Promise.all([fetchGearInstances(), fetchGearItemsCatalog()]);
  } catch (e) { warn('  gear check failed:', e.message); return; }
  const { toRepair, needsRestore } = decideGearActions(instances, catalog);
  for (const item of toRepair) {
    try {
      await repairGear(item.docId);
      log(`  gear: repaired ${item.name} (was 0 durability, ${item.usedRepairs}/${item.maxRepairs} repairs used)`);
    } catch (e) {
      warn(`  gear: repair failed for ${item.name}:`, e.message);
    }
  }
  for (const item of needsRestore) {
    const balances = await Promise.all(item.resetInputs.map(id => fetchItemBalance(id)));
    const shortfall = computeMaterialShortfall(item.resetInputs, item.resetAmounts, balances);
    if (shortfall.length) {
      const desc = shortfall.map(s => `${MATERIAL_NAMES[s.id] || ('item ' + s.id)} (need ${s.need}, have ${s.have})`).join(', ');
      const msg = `gear: ${item.name} is at 0 durability with repairs maxed (${item.usedRepairs}/${item.maxRepairs}) and needs Restore, but materials are short: ${desc}`;
      if (cfg.continueOnBrokenGear) { warn(`  ${msg} -- continuing anyway with it broken (--continueOnBrokenGear=true)`); continue; }
      throw new Error(`${msg} -- stopping so you can decide how to proceed (pass --continueOnBrokenGear=true to fish through this instead)`);
    }
    await restoreGear(item.docId);
    log(`  gear: RESTORED ${item.name} (was 0 durability, repairs maxed at ${item.maxRepairs}) -- rarity may have changed, Restore rerolls it`);
  }
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
// Which moveDistPrior band a fish falls in. Prefers the real fishMaxHp when the caller threads it
// through; otherwise infers from the canAlt/canThree flags so older callers (and tests that pass
// only those) still resolve to a sensible band instead of silently defaulting.
function moveBand(fishMaxHp, canAlt, canThree) {
  if (fishMaxHp == null) return canThree ? 'high' : canAlt ? 'mid' : 'low';
  if (fishMaxHp <= cfg.moveBandLowMaxHp) return 'low';
  return fishMaxHp >= cfg.threeMoveMinHp ? 'high' : 'mid';
}

function predict(history, opts) {
  const canAlt = !opts || opts.canAlternate !== false;
  const canThree = !!(opts && opts.canThree);
  const bandPrior = cfg.moveDistPrior[moveBand(opts && opts.fishMaxHp, canAlt, canThree)]
                    || cfg.moveDistPrior.low;
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
  const DISTS = canThree ? [1, 2, 3] : [1, 2];
  // Merge the per-distance candidate sets, each NORMALIZED to its own total first so that a
  // distance with more distinct paths doesn't thereby collect more belief, then scaled by the
  // caller's per-distance weight. Relative weights WITHIN a branch are preserved untouched --
  // those encode the real landing skew (e.g. the dist-2 diagonal) and are separately validated.
  const blend = (weights) => {
    const totals = new Map();
    for (const d of DISTS) {
      const share = weights[d] || 0;
      if (share <= 0) continue;
      const branch = reachableWeighted(cur, prev, d);
      const tot = branch.reduce((s, x) => s + x.w, 0);
      if (tot <= 0) continue;
      for (const { cell, w } of branch) {
        const key = K(...cell), add = (w / tot) * share;
        const e = totals.get(key);
        if (e) e.w += add; else totals.set(key, { cell, w: add });
      }
    }
    return [...totals.values()];
  };
  // Legacy raw union: sums branches WITHOUT normalizing, so each distance's share is decided by
  // its path count. Retained only for the low band, where it measurably beats a flat prior on
  // top-1 accuracy -- see moveDistPrior.low's comment.
  const rawUnionW = () => {
    const totals = new Map();
    for (const d of DISTS) {
      for (const { cell, w } of reachableWeighted(cur, prev, d)) {
        const key = K(...cell);
        const e = totals.get(key);
        if (e) e.w += w; else totals.set(key, { cell, w });
      }
    }
    return [...totals.values()];
  };
  const unionW = () => bandPrior.first ? blend(bandPrior.first) : rawUnionW();
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
    const others = DISTS.filter(d => d !== distSame);
    const prior = bandPrior.cont != null
      ? bandPrior.cont
      : (canThree ? cfg.threeMoveContinuationPrior : cfg.alternateContinuationPrior);
    // Split the non-continuation share across the other distances in proportion to this band's
    // measured base rate rather than evenly -- an even split would hand a >=28hp fish's "it
    // switched" mass 50% to d=3, which is measured at ~5%. Floored so a base rate of 0 (e.g.
    // d=3 in a band that has never shown one) still leaves a small non-zero hedge.
    const base = bandPrior.first || { 1: 0.5, 2: 0.5, 3: canThree ? 0.05 : 0 };
    const rate = d => Math.max(base[d] || 0, 0.02);
    const baseTot = others.reduce((s, d) => s + rate(d), 0) || 1;
    const weights = { [distSame]: prior };
    others.forEach(d => { weights[d] = (1 - prior) * rate(d) / baseTot; });
    return blend(weights);
  };
  let W, why, regimeKnown = true;
  if (!dists.length) { W = unionW(); why = 'regime unknown (cover 1+2' + (canThree ? '+3' : '') + ')'; regimeKnown = false; }
  // Deliberately a HARD lock, and the data says that is exactly right: not one <=21hp fish has
  // ever been seen to change its distance -- 0 of 157 fish with >=4 observed moves, 0 of 240
  // with >=2. (Count FISH, not transitions: alternation is a per-fish property, so transitions
  // within a cast are not independent evidence and quoting them inflates the sample ~3x.)
  // A first pass on 2026-09-13 reported 6 breaks across 2 casts and briefly tried hedging them;
  // both of those "casts" turned out to be CONCATENATED MULTI-FISH records -- two different fish's
  // regimes spliced into one turn list -- not a fish that switched. See the data-quality warning
  // about segmenting on TURN-level fishMaxHp in fishing-notes.md before re-running this analysis.
  // The hedge was reverted: it tripled the candidate set (3 cells -> 9) and diluted the exact
  // 50/25/25 dist-2 weights several validated tests pin, all to model an event with zero observed
  // instances. (Its apparent gain came from scoring by mean log-prob, which punishes an assigned
  // zero almost without bound -- a trap worth remembering when evaluating prediction changes.)
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
  // Redraws are a real, roughly constant tax on the mana budget (~35% of all turns, any fish size
  // -- see cfg.redrawRateEstimate's comment) that this affordability estimate used to ignore
  // entirely, implicitly pricing every future play at ~1 mana. For every real play turn, the
  // expected number of accompanying redraw turns is r/(1-r) (r = redrawRateEstimate), each costing
  // avgRedrawManaCost -- amortize that into the effective mana cost of one unit of progress instead
  // of assuming mana converts 1:1 into plays.
  const effectiveManaCostPerPlay = cfg.avgPlayManaCost
    + (cfg.redrawRateEstimate / (1 - cfg.redrawRateEstimate)) * cfg.avgRedrawManaCost;
  const totalManaNeeded = playsNeeded * effectiveManaCostPerPlay;
  const affordability = totalManaNeeded > 0 ? Math.max(0, Math.min(1, mana / totalManaNeeded)) : 1;
  return progress * affordability;
}

// Risk-adjusted score for RANKING candidate plays against each other -- see cfg.riskAversionWeight
// for the full story. Never used as a returned/propagated value; callers keep the TRUE playValue()
// for everything downstream (redraw comparison, recursion, logging), and use this only to decide
// WHICH candidate wins a comparison.
function riskAdjust(val, branches) {
  let missMass = 0;
  for (const { a, p } of branches) if (a < 0) missMass += p;
  return val - cfg.riskAversionWeight * missMass;
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
  const pr = predict(hist, { canAlternate: canAlt, canThree, telegraph, fishMaxHp });
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
  const pr = predict(hist, { canAlternate: canAlt, canThree, fishMaxHp });
  const catchBar = fishMaxHp - fishHp;
  let best = -Infinity, bestRiskAdj = -Infinity;
  hand.forEach((cardId, handIdx) => {
    const def = defs[cardId]; if (!def) return;
    if ((def.manaCost ?? 1) > mana) return;
    const candidates = positionsFor(def, bobber, focus, pr, catchBar, fishMaxHp).slice(0, cfg.lookaheadShortlist);
    for (const pos of candidates) {
      const val = playValue(defs, def, pos, cardId, handIdx, state, depth);
      const adj = riskAdjust(val, pos.branches);
      if (adj > bestRiskAdj) { bestRiskAdj = adj; best = val; }
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
    let bestPos = null, bestPosRiskAdj = -Infinity, zeroCost = null;
    for (const pos of candidates) {
      const val = playValue(defs, def, pos, cardId, handIdx, state, depth);
      const adj = riskAdjust(val, pos.branches);
      if (adj > bestPosRiskAdj) { bestPosRiskAdj = adj; bestPos = { pos, val }; }
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
    const bestPosAdj = riskAdjust(bestPos.val, bestPos.pos.branches);
    if (!bestPlay || bestPosAdj > bestPlay.riskAdj) bestPlay = { val: bestPos.val, riskAdj: bestPosAdj, handIdx, cardId, mana: cMana, focus: bestPos.pos.focus, moveCost: bestPos.pos.moveCost, pHit, ev: bestPos.pos.ev };
  });
  let redrawVal = -Infinity;
  if (allowRedraw !== false && (gs.hand || []).length > 0 && gs.playerHp >= gs.hand.length) {
    redrawVal = evaluateRedraw(defs, state, depth, gs.hand.length);
  }

  // --- depth-3 escalation on a close top-level call (audit item #5, see cfg.closeCallGap) -----
  // Scoped to ONLY the top-two candidates at the TOP level, not recursively inside lookaheadValue's
  // own future-ply search -- escalating there too would multiply the branching factor through the
  // whole tree, the same blowup the shortlist-rerank fix upstream of this deliberately avoided.
  let escalated = false, escalationAttempted = false, escalationTimedOut = false, escalationMs = null;
  if (cfg.closeCallGap > 0) {
    // Selecting/gap-checking here MUST use the same risk-adjusted score bestPlay was picked with
    // above (rank field), or escalation can pick and promote a DIFFERENT top-2 than the real
    // decision is actually contesting -- e.g. re-litigating card80 vs card85 (already-equivalent
    // options bestPlay already beat) while never even looking at the risk-preferred card88, then
    // overwriting bestPlay with whichever of ITS OWN top-2-by-raw-val wins. Confirmed live
    // 2026-09-14: this exact bug silently undid the cast #349 regression test's fix the moment
    // depth-3 escalation was left at its default (only caught because the earlier sanity checks
    // that validated the fix had closeCallGap explicitly disabled, which hid it). redraw has no
    // branches to discount -- it keeps its true val, exactly as bestPlay-vs-redraw always has.
    const cands = handEval.filter(h => h.playable)
      .map(h => ({ kind: 'play', handIdx: h.handIdx, cardId: h.cardId, val: h.val,
        rank: riskAdjust(h.val, posByHandIdx[h.handIdx].branches) }));
    if (redrawVal > -Infinity) cands.push({ kind: 'redraw', val: redrawVal, rank: redrawVal });
    cands.sort((a, b) => b.rank - a.rank);
    // Gap check MUST use raw val, not rank -- confirmed live 2026-09-19: redraw's rank is always
    // its raw val (never risk-discounted, per the comment above), but a play's rank IS discounted
    // by riskAdjust whenever it carries any real miss risk. That means a genuinely-close play-vs-
    // redraw call (raw gap 0.0079 on a real cast, well under the 0.01 threshold) can show a rank
    // gap several times larger (0.047 on that same cast) purely from the asymmetric discount --
    // not because the two options are actually far apart. The real, final decision this escalation
    // exists to double-check is made with raw vals (`redrawVal > bestPlay.val`, see the `return`
    // statements below) -- so the closeness check has to use the same scale that decision uses, or
    // it silently never escalates exactly the cases where a risky-but-live card is being compared
    // against redraw. rank stays the sort key (still needed to pick the RIGHT two candidates -- the
    // 2026-09-14 fix this comment block already describes), only the gap metric changes.
    if (cands.length >= 2 && (cands[0].val - cands[1].val) < cfg.closeCallGap) {
      escalationAttempted = true;
      const prevDeadline = lookaheadDeadline;
      const escStart = Date.now();
      lookaheadDeadline = escStart + cfg.depth3TimeBudgetMs;
      // Without this, escalation was completely silent from here until the turn's normal log line
      // prints (which only happens AFTER this whole block returns) -- on a slow escalation that's
      // up to depth3TimeBudgetMs of dead terminal output, indistinguishable from a hang to anyone
      // who doesn't already know this mechanism exists. User-requested 2026-09-23: make the pause
      // legible in the moment, not just after the fact in exported telemetry.
      log(`  (close call -- double-checking one move deeper, up to ${(cfg.depth3TimeBudgetMs / 1000).toFixed(0)}s; --maxTurnMs=N to change)`);
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
          const pos = posByHandIdx[c.handIdx];
          const adj3 = riskAdjust(c.val3, pos.branches);
          if (bestPlay && bestPlay.handIdx === c.handIdx) {
            bestPlay.val = c.val3; bestPlay.riskAdj = adj3;
          } else if (!bestPlay || adj3 > bestPlay.riskAdj) {
            bestPlay = { val: c.val3, riskAdj: adj3, handIdx: c.handIdx, cardId: c.cardId,
              mana: defs[c.cardId].manaCost ?? 1, focus: pos.focus, moveCost: pos.moveCost,
              pHit: he ? he.pHit : undefined, ev: pos.ev };
          }
        };
        applyEscalated(a);
        applyEscalated(b);
        escalated = true;
        escalationMs = Date.now() - escStart;
        log(`     (done in ${(escalationMs / 1000).toFixed(1)}s -- used the deeper check)`);
      } catch (e) {
        if (!(e instanceof LookaheadBudgetExceeded)) throw e;
        // ran out of time -- abandon the escalation, keep the original depth-2 ranking untouched.
        // escalationTimedOut is the signal that tells us (via the persisted turn snapshot -- see
        // playGame()) how often this actually happens live, which nothing tracked before 2026-09-19.
        escalationTimedOut = true;
        // escalationMs here is ~= depth3TimeBudgetMs by construction (the deadline that just fired),
        // not a real "how long would this have taken" measurement -- kept anyway for symmetry with
        // the success case and so a timed-out turn's snapshot still records SOMETHING it spent.
        escalationMs = Date.now() - escStart;
        // This is the concrete, in-the-moment demonstration of what a lower --maxTurnMs actually
        // costs: not a crash or a worse answer, just falling back to the original (faster, less
        // certain) 2-ply decision instead of the deeper one.
        log(`     (gave up after ${(escalationMs / 1000).toFixed(1)}s -- used the faster, less certain answer instead)`);
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
    (((defs[z.cardId].missEffects || []).find(e => e.type === 'FISH_HP') || {}).amount || 0) === 0);
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
    return { type: 'play', mv: forcedMv, redrawVal, handEval, escalated, escalationAttempted, escalationTimedOut, escalationMs };
  }

  if (!bestPlay && redrawVal === -Infinity) return { type: 'none', handEval, escalated, escalationAttempted, escalationTimedOut, escalationMs };
  if (!bestPlay || redrawVal > bestPlay.val) return { type: 'redraw', val: redrawVal, playVal: bestPlay && bestPlay.val, handEval, escalated, escalationAttempted, escalationTimedOut, escalationMs };
  return { type: 'play', mv: bestPlay, redrawVal, handEval, escalated, escalationAttempted, escalationTimedOut, escalationMs };
}

/* ---- deck draft ----------------------------------------------------------------- */
// scoreCard/rankDraft take an OPTIONAL opts object ({ zoneDensity, empirical }) so every existing
// caller/test that passes just a card def (or just the offered array) keeps working unchanged --
// deck-awareness and empirical priors are additive nudges on top of the static heuristic below,
// never a replacement for it (a brand-new/rarely-seen card still needs a sane static baseline).
function scoreCard(def, opts = {}) {
  const amt = t => (def[t] || []).reduce((s, e) => s + (e.type === 'FISH_HP' ? e.amount : 0), 0);
  const hit = amt('hitEffects'), miss = amt('missEffects'), crit = amt('critEffects');
  const cov = (def.hitZones || []).length, critN = (def.critZones || []).length;
  const mana = def.manaCost ?? 1;
  const plus = [2,4,6,8].every(z => (def.hitZones || []).includes(z));
  // Width/shape bonuses are capped by the card's OWN hit damage rather than flat constants --
  // found live 2026-09-12: card 9 (2 damage, 8/9 coverage) scored respectably in the draft almost
  // entirely from these two bonuses (6 + 4 = 10 of its 13.2 total), not from its real damage
  // output, because the old flat "+6 plus-shape"/"+4 cov>=8" bonuses didn't scale with how little
  // a hit was actually worth. Capping by `hit` keeps every existing tuned case intact (still
  // rewards wide/plus cards over narrow weak ones, still ranks the -10-miss and crit-only traps
  // correctly -- verified against all pre-existing draft tests) while no longer letting a
  // near-harmless card's score be dominated by shape alone.
  let s = hit * Math.min(cov, 4)
        + crit * critN * 0.4
        + (plus ? Math.min(hit, 6) : 0)
        + (cov >= 8 ? Math.min(hit, 4) : 0)
        + (miss === 0 ? 6 : 0)
        - Math.abs(miss) * 1.2;
  s = s / Math.max(mana, 0.5); // guard: card 17 is manaCost 0 -- s/0 would be Infinity/NaN

  // Deck complementarity (optional, user request 2026-09-12): a small nudge toward zones the
  // CURRENT deck covers thinly, without penalizing a duplicate of an already-strong card -- the
  // static score above still dominates for any real quality gap; this only breaks near-ties.
  if (opts.zoneDensity) {
    const zones = def.hitZones || [];
    if (zones.length) {
      const avgFill = zones.reduce((sum, z) => sum + 1 / (1 + (opts.zoneDensity[z] || 0)), 0) / zones.length;
      s += (cfg.draftDeckAwareWeight ?? 0) * avgFill;
    }
  }

  // Empirical prior (optional, user request 2026-09-12): this card's REAL average recursive
  // win-probability value (handEval.val), mined from every logged turn where it was playable --
  // already board-state- and mana-aware, a genuinely richer signal than any static heuristic. Used
  // as a 0.5x-1.5x MULTIPLIER (val is bounded [0,1]) rather than replacing the static score, so an
  // untested new card still gets a sane baseline instead of a hard zero. Only trusted once
  // cfg.empiricalMinSamples real samples exist (see loadEmpiricalPriors) -- below that it's noise.
  if (opts.empirical && opts.empirical[def.id] != null) {
    s *= (0.5 + opts.empirical[def.id]);
  }
  return s;
}
function rankDraft(offered, opts = {}) {
  return offered.map((d, i) => ({ i, id: d.id, mana: d.manaCost ?? 1, hit: d.hitZones, crit: d.critZones,
    plus: [2,4,6,8].every(z => (d.hitZones || []).includes(z)), score: +scoreCard(d, opts).toFixed(2) }))
    .sort((a, b) => b.score - a.score);
}
// How many (deck-instance) cards currently cover each of the 9 board zones -- duplicates count
// once per copy, since more copies covering a zone means that zone is even more saturated.
function zoneDensity(fullDeck, defsById) {
  const density = {};
  (fullDeck || []).forEach(id => {
    const def = defsById[id]; if (!def) return;
    (def.hitZones || []).forEach(z => { density[z] = (density[z] || 0) + 1; });
  });
  return density;
}
// Scans every logged run for this card's real handEval.val whenever it was a playable hand
// option -- NOT just the one ultimately played, so this reflects the card's value across every
// board state it was ever evaluated in, not just cherry-picked wins. Cached at module load (see
// call site in run()) since re-scanning runs/*.json on every single draft would be wasteful.
function loadEmpiricalPriors(runsDir) {
  const stats = {};
  let files = [];
  try { files = fs.readdirSync(runsDir).filter(f => f.endsWith('.json')); } catch (e) { return {}; }
  files.forEach(f => {
    let run;
    try { run = JSON.parse(fs.readFileSync(path.join(runsDir, f), 'utf8')); } catch (e) { return; }
    (run.turns || []).forEach(t => {
      (t.handEval || []).forEach(h => {
        if (!h.playable || h.val == null) return;
        const s = stats[h.cardId] || (stats[h.cardId] = { n: 0, sumVal: 0 });
        s.n++; s.sumVal += h.val;
      });
    });
  });
  const priors = {};
  Object.entries(stats).forEach(([id, s]) => {
    if (s.n >= (cfg.empiricalMinSamples ?? Infinity)) priors[id] = s.sumVal / s.n;
  });
  return priors;
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
// since a loss/daycap can end a game after just one fish (see run() below, 2026-09-10 change: "run
// N fish" now means N total fish across as many games as needed, not "stop at the first loss").
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
    await checkAndRepairGear();
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
  let oilBalance = cfg.useOils ? await fetchItemBalance(cfg.oilItemId) : 0;
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
      // Deck-aware draft context: zoneDensity needs defs for every card the CURRENT deck holds
      // (not just the 3 offered), which gs.deckCardData already carries (the same lookup used
      // everywhere else for chooseAction's defs). Falls back to no adjustment if fullDeck isn't
      // known yet (mirrors the same "unknown deck" fallback chooseAction already has).
      const defsById = {}; (gs.deckCardData || []).forEach(d => defsById[d.id] = d);
      const density = gs.fullDeck ? zoneDensity(gs.fullDeck, defsById) : null;
      const ranked = offered.length ? rankDraft(offered, { zoneDensity: density, empirical: empiricalPriorsCache }) : [];
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
      // Temporary debug hook (2026-09-10, user request): dump the FULL raw loot response so we can
      // check for any "hard cores" / Awakening-event reward field -- stateOf(resp) below only ever
      // extracted gameState.data, discarding any other top-level fields the response might carry.
      // Opt-in via env var so it's a no-op for normal runs; safe to leave in place.
      if (process.env.DEBUG_LOOT) {
        fs.mkdirSync(RUNS_DIR, { recursive: true });
        fs.appendFileSync(path.join(RUNS_DIR, '_debug-loot-raw.jsonl'), JSON.stringify(resp) + '\n');
      }
      if (last) last.draft = { options: ranked.map(r => r.id), picked: pick.id, scores: ranked.map(r => ({ id: r.id, score: r.score })) };
      gs = stateOf(resp); updateCards(run, gs);
      if (fishNo >= fishBudget) { run.meta.result = 'win'; log(`  stopping (fish budget ${fishBudget} reached this game) — matches "Leave", no fight left active`); return { result: 'win', fishPlayed: fishNo }; }
      await sleep(cfg.delayMs);
      // Same daily-cap rejection as the initial start_run above can land here too -- the cap can be
      // hit mid-batch, right after looting a catch, not just at the very start of a run(). Missing
      // this try/catch meant a mid-batch cap-out surfaced as a raw "error: start_run failed 400 ..."
      // instead of the clean daycap stop, even though the outcome (stop, nothing more to catch) was
      // identical -- confirmed live 2026-09-09 when this exact path fired after catching Plankton.
      await checkAndRepairGear();
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
      canThree: gs.fishMaxHp >= cfg.threeMoveMinHp, moveLens, telegraph: gs.nextPosition,
      fishMaxHp: gs.fishMaxHp });
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
        drawPool: gs.fullDeck ? drawPool(gs) : undefined, choiceVal: choice.val, playVal: choice.playVal, handEval: choice.handEval,
        escalated: choice.escalated, escalationAttempted: choice.escalationAttempted, escalationTimedOut: choice.escalationTimedOut, escalationMs: choice.escalationMs };
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
      drawPool: gs.fullDeck ? drawPool(gs) : undefined, choiceVal: mv.val, redrawVal: choice.redrawVal, handEval: choice.handEval,
      escalated: choice.escalated, escalationAttempted: choice.escalationAttempted, escalationTimedOut: choice.escalationTimedOut, escalationMs: choice.escalationMs };
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
// run object -- NOT a side effect of run() itself (test-run.js calls FB.run() directly against a
// mocked network and must never touch the real filesystem). The CLI entry point below is the only
// caller that passes exportRun here, so only a real CLI invocation ever writes files.
//
// "run N fish" means N fish TOTAL, across however many separate start_run games it takes -- a
// loss (or daycap, or anything else) ends the CURRENT game, but never the batch itself (per user
// 2026-09-10: don't stop at the first loss, keep going until the real target is met, and don't
// pause to ask about it mid-batch). cfg.maxGames is an optional extra safety cap on the number of
// games attempted (null/unset = uncapped -- the daily-cap rejection and the fish-total itself are
// the real backstops); most users never need to set it.
async function run(onGameDone) {
  stop = false; log('start. Ctrl+C to stop');
  // Escalation (the depth-3 close-call recheck) fires on roughly HALF of all turns in practice --
  // not a rare edge case -- so a first-time user needs this framing before it happens, not just in
  // documentation they may not have read. User-requested 2026-09-23, after live telemetry showed a
  // ~55% attempt rate (n=608 turns, 2026-09-20/21/22): explain what the pause is, that it's normal,
  // that it's controllable, and what controlling it actually trades away.
  log(`  on a close call (~half of turns), this may pause to double-check its answer one move`);
  log(`  deeper -- up to ${(cfg.depth3TimeBudgetMs / 1000).toFixed(0)}s by default. Lower with --maxTurnMs=N for faster turns; a lower`);
  log(`  cap just means it gives up sooner and uses its faster, less certain answer instead --`);
  log(`  it never crashes or hangs indefinitely either way.`);
  empiricalPriorsCache = loadEmpiricalPriors(RUNS_DIR);
  const nPriors = Object.keys(empiricalPriorsCache).length;
  if (nPriors) log(`  loaded empirical draft priors for ${nPriors} card(s) from past runs`);
  const out = [];
  // Escalation summary (piece 3 of the same 2026-09-23 UX request): tallied per completed game's
  // OWN run.turns (a fresh array each game, never shared across games -- see playGame()), guarded
  // by object identity so a game that produced zero new turns (e.g. an immediate crash) can't get
  // double-counted against a stale `lastRun` left over from an earlier game.
  let escTurns = 0, escAttempted = 0, escUsed = 0, escTimedOut = 0, lastTallied = null;
  const tallyEscalation = r => {
    if (!r || r === lastTallied || !r.turns) return;
    lastTallied = r;
    for (const t of r.turns) {
      if (t.action === 'redraw') continue;
      escTurns++;
      if (t.escalationAttempted) escAttempted++;
      if (t.escalated) escUsed++;
      if (t.escalationTimedOut) escTimedOut++;
    }
  };
  let remaining = cfg.maxFish, g = 0;
  while (remaining > 0 && !stop) {
    g++;
    if (cfg.maxGames != null && g > cfg.maxGames) {
      log(`  reached maxGames (${cfg.maxGames}) safety cap with ${remaining} fish still short of the target -- stopping`);
      break;
    }
    const lastRunBeforeAttempt = lastRun;
    let outcome;
    try {
      outcome = await playGame(g, remaining);
    } catch (e) {
      warn('error:', e.message); out.push('err');
      // A fatal error (e.g. "Not enough energy" on the NEXT fish's start_run) can strike after
      // real fish were already caught THIS game -- playGame() already updated lastRun in memory
      // for each catch (see updateCards/lastRun assignment inside playGame's fish loop), it just
      // never got exported because that normally happens via onGameDone below, which this break
      // used to skip entirely. Confirmed live 2026-09-11: a 2-catch game crashed on fish #3's
      // start_run and both real catches (with drafted cards already added to the account's deck)
      // were silently lost -- never written to disk, never merged into the replay viewer, even
      // though they genuinely happened.
      //
      // Only export if lastRun actually changed identity during THIS attempt -- playGame() creates
      // a brand-new `run` object right after ITS OWN start_run succeeds, so if the crash struck
      // before that (e.g. the very first start_run of a fresh game, zero catches yet), lastRun is
      // still whichever earlier game's object was already exported by a prior onGameDone call.
      // Exporting unconditionally here would re-emit that stale object as if it were new progress,
      // creating a duplicate.
      if (onGameDone && lastRun && lastRun !== lastRunBeforeAttempt) onGameDone(lastRun, g);
      tallyEscalation(lastRun);
      break;
    }
    out.push(outcome.result);
    remaining -= outcome.fishPlayed;
    tallyEscalation(lastRun);
    // lastRun (and therefore exportRun(), which just reads it) only ever holds the MOST RECENT
    // playGame() call's data -- with multiple games in one batch every earlier game used to be
    // silently overwritten and never saved (found live 2026-09-10 running a 4-game batch: only the
    // final game's run JSON ever existed on disk). Calling onGameDone here, once per completed
    // game, is what actually fixes it -- exporting once after the whole loop can only see the last.
    if (onGameDone) onGameDone(lastRun, g);
    if (outcome.result === 'daycap') { log('  stopping: daily cap reached, no more games possible today'); break; }
    await sleep(cfg.delayMs);
  }
  if (escTurns > 0) {
    const pct = n => (100 * n / escTurns).toFixed(0);
    log(`  escalation: attempted on ${escAttempted}/${escTurns} turns (${pct(escAttempted)}%), used the deeper` +
      ` answer ${escUsed} times, gave up (timed out) ${escTimedOut} times` +
      (escAttempted ? ` (${(100 * escTimedOut / escAttempted).toFixed(0)}% of attempts)` : '') +
      ` -- lower --maxTurnMs for faster turns, at the cost of more timeouts like these.`);
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
  // --maxTurnMs is a friendlier alias for cfg.depth3TimeBudgetMs -- same underlying knob (any cfg
  // field is already settable via --fieldName=value, but that internal name gives no hint of what
  // it controls). This is the cap on how long the bot may spend re-checking a close call one ply
  // deeper before falling back to its 2-ply answer -- see depth3TimeBudgetMs's cfg comment for why
  // the shipped default (90s) favors decision quality over turn speed. Lower it for snappier turns
  // at the cost of occasionally missing a close-call improvement; raise it to never time out.
  if ('maxTurnMs' in args) { args.depth3TimeBudgetMs = args.maxTurnMs; delete args.maxTurnMs; }
  Object.assign(cfg, args);
  process.on('SIGINT', () => { stop = true; log('stopping...'); });
  promptForOilConfig(oilFlagGiven)
    .then(() => run(exportRun))
    .catch(e => { warn('fatal:', e.message); process.exit(1); });
}

module.exports = { run, stop: () => { stop = true; }, config: o => Object.assign(cfg, o),
  rankDraft, scoreCard, exportRun, getRun: () => lastRun, cfg,
  _predict: predict, _decide: decide, _shouldRedraw: shouldRedraw, _drawPool: drawPool, _effectAt: effectAt, _reachable: reachable, _reachableWeighted: reachableWeighted, _zoneCell: zoneCell,
  _chooseAction: chooseAction, _lookaheadValue: lookaheadValue, _bestPositionFor: bestPositionFor, _positionsFor: positionsFor, _evaluateRedraw: evaluateRedraw, _combos: combos, _playValue: playValue,
  _zoneDensity: zoneDensity, _loadEmpiricalPriors: loadEmpiricalPriors, _leafEstimate: leafEstimate,
  _decideGearActions: decideGearActions, _checkAndRepairGear: checkAndRepairGear,
  _computeMaterialShortfall: computeMaterialShortfall };
