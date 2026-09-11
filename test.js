// offline unit tests for the pure logic in fishbot-node.js (the sole maintained engine --
// fishbot.js is a frozen/deprecated browser-console snapshot, see its header comment).
const FB = require('./fishbot-node.js');

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? 'PASS ' : 'FAIL ') + name, ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  ok ? pass++ : fail++;
};

// card defs (from the real catalog)
const card4 = { id:4, hitZones:[1,4,7], critZones:[], hitEffects:[{type:'FISH_HP',amount:5}], missEffects:[{type:'FISH_HP',amount:-3}], critEffects:[] };
const card8 = { id:8, hitZones:[2,4,6,8], critZones:[], hitEffects:[{type:'FISH_HP',amount:5}], missEffects:[{type:'FISH_HP',amount:-5}], critEffects:[] };
const card9 = { id:9, hitZones:[1,2,3,4,6,7,8,9], critZones:[], hitEffects:[{type:'FISH_HP',amount:2}], missEffects:[{type:'FISH_HP',amount:-4}], critEffects:[] };

// 1) geometry: confirmed real trace — card4 @ focus[2,2] hits fish at [2,1] for +5
eq('zoneCell(4 @2,2) = [2,1]', FB._zoneCell(4, 2, 2), [2, 1]);
eq('card4 @[2,2] on fish[2,1] => +5 (HIT, matches captured game)', FB._effectAt(card4, 2, 2, [2, 1]), 5);
eq('card4 @[2,2] on fish[2,2] => -3 (miss, center not a hit square)', FB._effectAt(card4, 2, 2, [2, 2]), -3);

// 2) card8 "plus" centered on a 1-move fish covers ALL orth-neighbors => guaranteed hit
for (const nb of [[1,2],[3,2],[2,1],[2,3]]) eq('card8 @[2,2] covers neighbor '+nb, FB._effectAt(card8, 2, 2, nb), 5);
eq('card8 @[2,2] center is a MISS (fish would be back-square anyway)', FB._effectAt(card8, 2, 2, [2, 2]), -5);

// 3) reachable: 1-move fish from corner [1,1], came from [1,2] -> only [2,1] left
eq('reachable corner 1-move excl prev', FB._reachable([1,1],[1,2],1).sort(), [[2,1]]);
// 1-move from center [2,2], came from [1,2] -> neighbors minus [1,2]
eq('reachable center 1-move excl prev', FB._reachable([2,2],[1,2],1).map(c=>c.join(',')).sort(), ['2,1','2,3','3,2']);
// 2-move fish never ends on its start square: from square 4 [1,4] -> only 2,7,12 (not 4)
eq('reachable 2-move from sq4 = squares 2,7,12 (excludes start)', FB._reachable([1,4],[2,4],2).map(c=>(c[0]-1)*4+c[1]).sort((a,b)=>a-b), [2,7,12]);

// 3b) reachableWeighted: a 2-move fish taking two independent orthogonal steps reaches a
// "diagonal" square via TWO path combos (right-then-up / up-then-right) but a straight
// two-in-a-row square via only ONE -> diagonal should be twice as likely, not equally likely.
// From corner square1 [1,1]: square6 [2,2] (diagonal) should have weight 2 vs weight 1 for
// square3 [1,3] and square9 [3,1] (the straight-line squares).
{ const w = FB._reachableWeighted([1,1], [2,1], 2);
  const bySq = {}; w.forEach(({cell, w:wt}) => bySq[(cell[0]-1)*4+cell[1]] = wt);
  eq('2-move from square1: diagonal square6 has weight 2', bySq[6], 2);
  eq('2-move from square1: straight square3 has weight 1', bySq[3], 1);
  eq('2-move from square1: straight square9 has weight 1', bySq[9], 1);
  const total = w.reduce((s,x)=>s+x.w,0);
  eq('2-move from square1: square6 is 50% (not uniform 33%)', bySq[6]/total, 0.5); }
// dist=1 must stay perfectly uniform (every reachable cell has exactly one path)
{ const w = FB._reachableWeighted([2,2], [1,2], 1);
  eq('1-move weights are all 1 (uniform, unaffected by path-count change)', w.every(x=>x.w===1), true); }

// 4) predict: movement is UNIFORMLY random among legal squares — NO pattern is ever inferred.
//    Three same-direction moves must NOT make [2,4] "certain" or even favored.
const topCell = p => p.cand.reduce((a,b)=>b.p>a.p?b:a).cell;
{ const p = FB._predict([[2,1],[2,2],[2,3]]);             // 1-move regime, currently at [2,3], came from [2,2]
  eq('no cycle inference: not exact', p.exact, false);
  eq('all legal squares equally likely (uniform)', p.cand.every(c=>Math.abs(c.p - 1/p.cand.length) < 1e-9), true);
  eq('[2,4] is just one of several options, not favored', p.cand.length > 1, true);
  eq('no-backtrack: [2,2] excluded', p.cand.every(c=>!(c.cell[0]===2&&c.cell[1]===2)), true); }
// 5) an oscillation-looking history is still uniform, never "exact"
{ const p = FB._predict([[3,2],[3,3],[3,2],[3,3],[3,2]]);   // looks like oscillation, but we infer nothing
  eq('oscillation-looking history is NOT exact', p.exact, false);
  eq('oscillation candidates uniform', p.cand.every(c=>Math.abs(c.p - 1/p.cand.length) < 1e-9), true);
  eq('no-backtrack still holds: [3,3] excluded', p.cand.every(c=>!(c.cell[0]===3&&c.cell[1]===3)), true); }
// 6) decide: with a covering card in hand and 0 focus, picks a 0-move guaranteed hit
{ const gs = { hand:[8], deckCardData:[card8], focusPoint:[2,2], focusMeter:0, focusMeterMax:3, playerHp:7, fishHp:10, fishMaxHp:20 };
  const pr = { cand:[{cell:[2,1],p:0.34},{cell:[2,3],p:0.33},{cell:[3,2],p:0.33}], exact:false, why:'t' };
  const d = FB._decide(gs, pr);
  eq('decide uses card8 with no focus move (EV=+5)', [d.cardId, d.moveCost, Math.round(d.ev)], [8, 0, 5]); }

// 7) decide skips a card we can't afford (2-mana card with only 1 mana left)
{ const card12 = { id:12, manaCost:2, hitZones:[1,2,3,4,6,7,8,9], critZones:[], hitEffects:[{type:'FISH_HP',amount:5}], missEffects:[{type:'FISH_HP',amount:-10}], critEffects:[] };
  const gs = { hand:[12], deckCardData:[card12], focusPoint:[2,2], focusMeter:0, playerHp:1 };
  const pr = { cand:[{cell:[2,1],p:1}], exact:true, why:'t' };
  eq('decide returns null when only card is unaffordable', FB._decide(gs, pr), null); }

// 7b) regime classifier + HP indication (>21 HP can alternate; <=21 cannot)
{ const p = FB._predict([[2,2]]);                       // turn 1, no moves seen yet
  eq('regime unknown on turn 1 (covers 1+2)', /unknown/.test(p.why), true); }
// <=21 HP fish: one move LOCKS the regime
{ const p = FB._predict([[2,2],[2,3]], {canAlternate:false});   // net-1 -> locked always-1
  eq('<=21hp net-1 locks always-1', /always-1/.test(p.why), true);
  eq('<=21hp always-1 candidates are the 1-move neighbors', p.cand.length, 3); } // [1,3],[3,3],[2,4] (excl backtrack [2,2])
{ const p = FB._predict([[1,2],[2,1]], {canAlternate:false});   // net-2 -> locked always-2
  eq('<=21hp net-2 locks always-2', /always-2/.test(p.why), true); }
{ // fish now at square1 [1,1] (came from [1,3], distance 2 -> locked always-2). predict() should
  // carry the path-count weighting through end-to-end: diagonal square6 at 50%, not uniform 33%.
  const p = FB._predict([[1,3],[1,1]], {canAlternate:false});
  eq('always-2 from square1 locks regime', /always-2/.test(p.why), true);
  const bySq = {}; p.cand.forEach(c => bySq[(c.cell[0]-1)*4+c.cell[1]] = c.p);
  eq('predict() end-to-end: 2-move diagonal square6 weighted to 50%', Math.abs(bySq[6]-0.5)<1e-9, true);
  eq('predict() end-to-end: 2-move straight squares at 25% each', Math.abs(bySq[3]-0.25)<1e-9 && Math.abs(bySq[9]-0.25)<1e-9, true); }
// >21 HP fish: one move is NOT enough (could be alternating) -> still cover 1+2
{ const p = FB._predict([[2,2],[2,3]], {canAlternate:true});
  eq('>21hp after 1 move still covers 1+2 (could alternate)', /alternate|1\+2/.test(p.why), true); }
// ...but "could still alternate" is NOT a flat 50/50 union of dist-1 and dist-2 candidates.
// The observed move is evidence about which TYPE of mover this fish is -- most canAlt-eligible
// fish settle into a fixed always-X regime rather than genuinely alternate (measured live: 5 of
// 6 canAlt fish today locked into always-X after their first move). So after seeing a dist-1
// move, the dist-1-continuation squares should carry cfg.alternateContinuationPrior (0.75)
// combined, not be diluted by pooling with the dist-2 "flip" squares as equally likely.
{ const p = FB._predict([[2,2],[2,3]], {canAlternate:true});   // one move, distance 1
  const dist1Sqs = new Set([3,8,11]);   // reachable via a single 1-move step from square7=[2,3]
  const p1 = p.cand.filter(c => dist1Sqs.has((c.cell[0]-1)*4+c.cell[1])).reduce((s,c)=>s+c.p,0);
  eq('favors dist-1 continuation at ~75% combined, not a flat union', Math.abs(p1 - 0.75) < 1e-9, true); }
{ const p = FB._predict([[2,2],[2,3],[2,1]], {canAlternate:true}); // net1 then net2 -> alternating, next=1
  eq('>21hp alternating -> next dist 1', /alternating -> 1/.test(p.why), true); }

// 7c) fintuition telegraph: if the game reveals the next square, predict it exactly
{ const p = FB._predict([[2,3]], {telegraph:[4,3], canAlternate:false});
  eq('telegraph gives exact prediction', [p.exact, p.cand[0].cell, /telegraph/.test(p.why)], [true, [4,3], true]); }
{ const p = FB._predict([[2,3]], {telegraph:[9,9]});   // off-board telegraph ignored
  eq('off-board telegraph ignored (falls back)', p.exact, false); }

// 7c2) three-move (>=29hp) fish -- confirmed live 2026-09-10, real fish alternate 1<->3 or 2<->3.
// THE key bug this fixes: net Manhattan distance between positions is ambiguous for a 3-step move
// that doubles back (nets to 1), so predict() must use REAL step count (moveLens) when available,
// not just position deltas -- these two positions alone (dist=1 each) would otherwise misclassify
// a genuine always-3 fish as always-1.
{ const hist = [[2,2],[2,3],[2,2]]; // net distance 1 then 1 (looks like always-1 from position alone)
  const withoutMoveLens = FB._predict(hist, {canAlternate:true, canThree:true});
  eq('without moveLens, ambiguous net-1s read as always-1 (the bug this fixes)', /always-1/.test(withoutMoveLens.why), true);
  const withMoveLens = FB._predict(hist, {canAlternate:true, canThree:true, moveLens:[3,3]});
  eq('WITH real moveLens, the same net-1 positions correctly read as always-3', /always-3/.test(withMoveLens.why), true); }
// Real fish 1 (2026-09-09 loss): step sequence 1,3,1,3 -> alternating 1<->3
{ const p = FB._predict([[3,4],[3,3],[3,4],[4,4],[3,2]], {canAlternate:true, canThree:true, moveLens:[1,3,1,3]});
  eq('real fish 1 pattern classifies as alternating 1<->3', /alternating 1<->3 -> 1/.test(p.why), true); }
// Real fish 2 (2026-09-10 loss): step sequence 3,2,3,2 -> alternating 2<->3
{ const p = FB._predict([[3,1],[3,2],[4,3],[4,4],[2,4]], {canAlternate:true, canThree:true, moveLens:[3,2,3,2]});
  eq('real fish 2 pattern classifies as alternating 2<->3', /alternating 2<->3 -> 3/.test(p.why), true); }
// Legacy 1<->2 alternation keeps its EXACT old string (no spurious "1<->2" pair annotation) so
// existing log-scanning/regex assumptions elsewhere in the codebase keep working.
{ const p = FB._predict([[2,2],[2,3],[2,1]], {canAlternate:true, canThree:false});
  eq('legacy 1<->2 alternation keeps the exact old "why" string', p.why, 'regime alternating -> 1'); }
// Blind opening on a canThree fish covers dist-3 candidates too, not just 1+2.
{ const p3 = FB._predict([[2,2]], {canAlternate:true, canThree:true});
  const p2 = FB._predict([[2,2]], {canAlternate:true, canThree:false});
  eq('canThree blind opening reaches strictly more candidate cells than a non-canThree one', p3.cand.length > p2.cand.length, true); }
// No-backtrack rule at dist=3: no path may reverse the immediately-preceding step (verified via the
// geometry helper directly, not just predict()'s aggregate output).
{ const cells3 = FB._reachable([2,2], [2,1], 3).map(c => c.join(','));
  // from [2,2] having just arrived from [2,1] (i.e. moved [2,1]->[2,2]), a legal 3-step walk's
  // FIRST new step still may not return to [2,1] per dist===1-style logic only at s>=1 -- but the
  // walk's own step2/step3 must never undo step1/step2. Sanity check: [2,2] itself (net-0) is
  // impossible for 3 steps (proven by parity: 3 orthogonal unit steps can never sum to zero).
  eq('dist=3 walk never nets back to the exact start (impossible by parity)', cells3.includes('2,2'), false); }
{ // structural: every dist=3 end cell must be reachable via a path whose 2nd/3rd step doesn't
  // undo the prior one -- spot-check a specific 3-step path is honored: [2,2] -> up,right,up
  // lands on [ (2-1-1), (2+1) ] = [0,3] (off-board) so use a safer interior start instead.
  const cells = FB._reachable([2,2], null, 3);
  // net distance for every returned cell must be 1 or 3 (2 and 0 are impossible by parity)
  const dists = cells.map(c => Math.abs(c[0]-2) + Math.abs(c[1]-2));
  eq('every dist=3 result has net distance 1 or 3, never 0 or 2 (parity)', dists.every(d => d === 1 || d === 3), true); }

// 7c3) zero-miss-penalty + zero-focus-cost card beats redraw, hardcoded rule (user 2026-09-10,
// after a live investigation into a real case -- viewer #169's turn 1 -- where the recursive engine
// undervalued exactly this scenario). A card playable from the CURRENT bobber position (no focus
// spent) whose miss effect is 0 should never lose to a redraw: you can play it for strictly
// non-negative progress and still redraw next turn (cheaper, with a smaller hand) if needed.
{ const mkZ = (id, hit, missAmt, hitAmt) => ({ id, manaCost: 1, hitZones: hit, critZones: [],
    hitEffects: [{ type: 'FISH_HP', amount: hitAmt }], missEffects: [{ type: 'FISH_HP', amount: missAmt }], critEffects: [] });
  const freeCard = mkZ(900, [1,2,3,4,5,6,7,8,9], 0, 1); // covers everywhere from [2,2], zero miss penalty
  const weak1 = mkZ(901, [1], -5, 3); // narrow, real miss penalty
  const weak2 = mkZ(902, [3], -5, 3);
  const filler = [903,904,905,906,907].map(id => mkZ(id, [5], -4, 4));
  const deckCardData = [freeCard, weak1, weak2, ...filler];
  const fullDeck = deckCardData.map(d => d.id);
  const gs = { deckCardData, hand: [900, 901, 902], playerHp: 10, playerMaxHp: 14,
    focusMeter: 3, focusMeterMax: 3, focusPoint: [2,2], fishHp: 20, fishMaxHp: 25,
    fullDeck, discard: [] };
  const hist = [[2,2]];
  const pr = FB._predict(hist, { canAlternate: false });
  const choice = FB._chooseAction(gs, hist, pr, true);
  eq('zero-cost zero-penalty card beats redraw', choice.type === 'play' && choice.mv.cardId === 900, true);
  eq('forced free-card play carries zero moveCost', choice.mv.moveCost, 0); }
// Sanity check: with NO zero-miss-penalty card in hand, the rule must not fire at all --
// confirms it's genuinely scoped to that exact case, not just always forcing some card.
{ const mkZ = (id, hit, missAmt, hitAmt) => ({ id, manaCost: 1, hitZones: hit, critZones: [],
    hitEffects: [{ type: 'FISH_HP', amount: hitAmt }], missEffects: [{ type: 'FISH_HP', amount: missAmt }], critEffects: [] });
  const weak1 = mkZ(901, [1], -5, 3), weak2 = mkZ(902, [3], -5, 3), weak3 = mkZ(908, [5], -5, 3);
  const filler = [903,904,905,906,907].map(id => mkZ(id, [5], -4, 4));
  const deckCardData = [weak1, weak2, weak3, ...filler];
  const fullDeck = deckCardData.map(d => d.id);
  const gs = { deckCardData, hand: [901, 902, 908], playerHp: 10, playerMaxHp: 14,
    focusMeter: 3, focusMeterMax: 3, focusPoint: [2,2], fishHp: 20, fishMaxHp: 25,
    fullDeck, discard: [] };
  const hist = [[2,2]];
  const pr = FB._predict(hist, { canAlternate: false });
  const choice = FB._chooseAction(gs, hist, pr, true);
  eq('rule does not fire when no zero-miss-penalty card is in hand', !!(choice.mv && choice.mv.forcedFreeCard), false); }

// 7c3-bis) REGRESSION (found live 2026-09-11, viewer #200): a zero-miss-penalty card whose
// missEffects array has NO FISH_HP entry at all (real API shape for "miss does nothing" -- it
// omits the effect rather than sending an explicit amount:0, matching card 16's real def) must
// still qualify as a free card. The rule's filter used to do `....amount === 0` with no `|| 0`
// fallback, unlike every other amount-lookup in the file -- `undefined === 0` is false, so this
// exact real-world shape silently never matched and the engine redrew away a genuinely free card.
{ const mkZ = (id, hit, hitAmt, missEffects) => ({ id, manaCost: 1, hitZones: hit, critZones: [],
    hitEffects: [{ type: 'FISH_HP', amount: hitAmt }], missEffects, critEffects: [] });
  const freeCard = mkZ(900, [1,2,3,4,5,6,7,8,9], 1, []); // real card-16 shape: no FISH_HP miss entry at all
  const weak1 = mkZ(901, [1], 3, [{ type: 'FISH_HP', amount: -5 }]);
  const weak2 = mkZ(902, [3], 3, [{ type: 'FISH_HP', amount: -5 }]);
  const filler = [903,904,905,906,907].map(id => mkZ(id, [5], 4, [{ type: 'FISH_HP', amount: -4 }]));
  const deckCardData = [freeCard, weak1, weak2, ...filler];
  const fullDeck = deckCardData.map(d => d.id);
  const gs = { deckCardData, hand: [900, 901, 902], playerHp: 10, playerMaxHp: 14,
    focusMeter: 3, focusMeterMax: 3, focusPoint: [2,2], fishHp: 20, fishMaxHp: 25,
    fullDeck, discard: [] };
  const hist = [[2,2]];
  const pr = FB._predict(hist, { canAlternate: false });
  const choice = FB._chooseAction(gs, hist, pr, true);
  eq('zero-cost card with an EMPTY missEffects array still beats redraw', choice.type === 'play' && choice.mv.cardId === 900, true); }

// 7d) redraw = balanced value decision + mana-budget (can we still afford to catch after redrawing?)
const cands = n => ({ cand: Array.from({length:n}, () => ({cell:[1,1], p:1/n})) });  // n candidate cells
const blindPr = { ...cands(8), regimeKnown: false };   // movement still unknown -> scouting has value
const lockedPr = { ...cands(3), regimeKnown: true };    // regime pinned -> a redraw reveals nothing
const deck5 = [{ hitEffects:[{type:'FISH_HP',amount:5}], hitZones:[1], critZones:[] }];  // avg dmg 5
const gsB = o => Object.assign({ deckCardData:deck5 }, o);   // budget-aware gs
const weak = {ev:0.5,guaranteedCatch:false}, strong = {ev:4,guaranteedCatch:false};
{ // blind opening, plenty mana, low fish HP (2 hits) -> affordable weak-hand redraw
  eq('blind opening, affordable -> redraw', FB._shouldRedraw(gsB({hand:[1,2,3],playerHp:8,fishHp:10}), weak, blindPr), true);
  // a strong card in hand -> just play it
  eq('blind opening w/ strong card -> no redraw', FB._shouldRedraw(gsB({hand:[1,2,3],playerHp:8,fishHp:10}), strong, blindPr), false);
  // MANA BUDGET: fish needs ~4 hits (~6 plays at 0.7), redraw would leave only 5 -> DON'T redraw
  eq('budget: redraw would strand the catch -> no redraw', FB._shouldRedraw(gsB({hand:[1,2,3],playerHp:8,fishHp:20}), weak, blindPr), false);
  // ...but a 3-hit fish (15hp) leaves 5 plays after redraw = exactly the expected plays-to-catch -> AFFORDABLE.
  // (regression: the old +1 buffer wrongly blocked this; the /expectedHitRate term already covers the misses)
  eq('budget: 3-hit fish, 5 plays after redraw -> affordable (redraw)', FB._shouldRedraw(gsB({hand:[1,2,3],playerHp:8,fishHp:15}), weak, blindPr), true);
  // low mana -> can't afford -> no redraw
  eq('low mana -> no redraw', FB._shouldRedraw(gsB({hand:[1,2,3],playerHp:5,fishHp:10}), weak, blindPr), false);
  // known regime, decent play -> no redraw
  eq('known regime, decent play -> no redraw', FB._shouldRedraw(gsB({hand:[1,2],playerHp:8,fishHp:10}), {ev:3,guaranteedCatch:false}, lockedPr), false); }

// 8) draft: plus card (8) ranks above ring (9) which ranks above a weak line card
{ const weak = { id:2, manaCost:1, hitZones:[4,5,6], critZones:[], hitEffects:[{type:'FISH_HP',amount:5}], missEffects:[{type:'FISH_HP',amount:-3}], critEffects:[] };
  const ranked = FB.rankDraft([card9, weak, card8]);
  eq('draft ranks plus(8) first', ranked[0].id, 8); }

// real card defs for the escape/draft-schema tests
const card10 = { id:10, manaCost:1, hitZones:[],           critZones:[5], hitEffects:[], missEffects:[{type:'FISH_HP',amount:-5}], critEffects:[{type:'FISH_HP',amount:10}] };
const card12 = { id:12, manaCost:2, hitZones:[1,2,3,4,6,7,8,9], critZones:[], hitEffects:[{type:'FISH_HP',amount:5}], missEffects:[{type:'FISH_HP',amount:-10}], critEffects:[] };
const card16 = { id:16, manaCost:1, hitZones:[1,2,3,4,5,6,7,8,9], critZones:[], hitEffects:[{type:'FISH_HP',amount:1}], missEffects:[], critEffects:[] };
const card28 = { id:28, manaCost:1, hitZones:[1,2,3,4,7],   critZones:[], hitEffects:[{type:'FISH_HP',amount:6}], missEffects:[{type:'FISH_HP',amount:-3}], critEffects:[] };

// 9) draft schema: the -10-miss card and the crit-only trap must NOT beat a solid safe/damage card
{ const ranked = FB.rankDraft([card12, card16, card28]);
  eq('draft does NOT pick the -10-miss card (12)', ranked[0].id !== 12, true);
  eq('draft: card 12 (-10 miss) ranks last of the three', ranked[ranked.length-1].id, 12);
  eq('crit-only card (10) scores below a normal damage card (28)', FB.scoreCard(card10) < FB.scoreCard(card28), true); }

// 10) evaluation: never play the crit-only trap when a real hit card is available (crit NOT lethal here)
{ const gs = { hand:[10,2], deckCardData:[card10, {id:2,manaCost:1,hitZones:[4,5,6],critZones:[],hitEffects:[{type:'FISH_HP',amount:5}],missEffects:[{type:'FISH_HP',amount:-3}],critEffects:[]}],
    focusPoint:[2,2], focusMeter:1, playerHp:7, fishHp:25, fishMaxHp:30 };   // catch bar 5, crit(10) not lethal
  const pr = { cand:[{cell:[2,1],p:0.5},{cell:[2,3],p:0.5}], exact:false, why:'t' };   // horizontal pair -> card2 covers both
  const d = FB._decide(gs, pr);
  eq('decide avoids crit-only card, plays the real hit card', d.cardId, 2); }

// 11) escape-danger: near escape (catch bar low), a card whose miss would escape is heavily penalized
{ const risky = card8;   // miss -5
  const safe  = card16;  // miss 0
  const gs = { hand:[8,16], deckCardData:[card8, card16], focusPoint:[2,2], focusMeter:1, playerHp:7, fishHp:17, fishMaxHp:20 }; // catch bar = 3, a -5 miss escapes
  const pr = { cand:[{cell:[2,1],p:0.5},{cell:[3,3],p:0.5}], exact:false, why:'t' };
  const d = FB._decide(gs, pr);
  eq('near escape -> avoid the big-miss card, use the safe one', d.cardId, 16); }

// 12) 50% action threshold: sub-50% best play -> prefer redraw (when affordable AND the pile can help)
const card1d = { id:1, manaCost:1, hitZones:[1,2,3], critZones:[], hitEffects:[{type:'FISH_HP',amount:5}], missEffects:[{type:'FISH_HP',amount:-3}], critEffects:[] };
const card2d = { id:2, manaCost:1, hitZones:[4,5,6], critZones:[], hitEffects:[{type:'FISH_HP',amount:5}], missEffects:[{type:'FISH_HP',amount:-3}], critEffects:[] };
{ const gs = { deckCardData:[card1d,card2d,card8], hand:[1,2], discard:[], fullDeck:[1,2,8], playerHp:8, fishHp:10 };  // draw pile has the strong plus(8)
  eq('sub-50% + better card in pile -> redraw', FB._shouldRedraw(gs, {ev:3, pHit:0.3, guaranteedCatch:false}, lockedPr), true);
  eq('play >=50% -> just play', FB._shouldRedraw(gs, {ev:3, pHit:0.7, guaranteedCatch:false}, lockedPr), false); }

// 13) DECK AWARENESS: don't redraw a sub-50% play if the draw pile is only junk (unless it'd heal)
{ const gs = { deckCardData:[card1d,card2d,card8], hand:[8], discard:[], fullDeck:[8,1,2], playerHp:8, fishHp:10 }; // holding the best card; pile is weaker
  eq('sub-50% but pile is worse than hand -> do NOT redraw', FB._shouldRedraw(gs, {ev:1, pHit:0.3, guaranteedCatch:false}, lockedPr), false);
  eq('sub-50% + would heal the fish -> redraw anyway', FB._shouldRedraw(gs, {ev:-2, pHit:0.3, guaranteedCatch:false}, lockedPr), true); }

// 13b) a RELIABLE play (~80% to hit, e.g. card 76) must be kept, never redrawn away for a better-scored card
{ const gs = { deckCardData:[card1d,card2d,card8], hand:[1,2], discard:[], fullDeck:[1,2,8], playerHp:8, fishHp:10 };
  eq('reliable ~80% play -> keep it (no redraw even w/ better pool)', FB._shouldRedraw(gs, {ev:1.4, pHit:0.8, guaranteedCatch:false}, blindPr), false); }

// 13b-i) RELIABILITY BIAS: a wide reliable card (#76, 8 squares, low dmg) should be PLAYED over a
//   higher-damage coin-flip (#28), and NEVER redrawn away on a blind opening — a play scouts for free.
//   (the live t0 case: hand [76,7,28] vs a fresh 15hp fish at [1,2], bobber [2,2], 3 focus)
{ const mk=(id,hit,h)=>({id,manaCost:1,hitZones:hit,critZones:[],hitEffects:[{type:'FISH_HP',amount:h}],missEffects:[{type:'FISH_HP',amount:-3}],critEffects:[]});
  const c76=mk(76,[1,2,3,4,6,7,8,9],3), c7=mk(7,[1,3,7,9],6), c28=mk(28,[1,2,3,4,7],6);
  const gs={hand:[76,7,28],deckCardData:[c76,c7,c28],focusPoint:[2,2],focusMeter:3,playerHp:8,fishHp:9,fishMaxHp:15,fullDeck:[76,7,28,1,2,3,4,5,6],discard:[]};
  const pr=FB._predict([[1,2]],{canAlternate:false});
  const best=FB._decide(gs,pr);
  eq('reliability bias: plays wide reliable #76 over the higher-dmg 57% gamble #28', best.cardId, 76);
  eq('holding a reliable play -> do NOT pay to scout (no redraw)', FB._shouldRedraw(gs,best,pr), false); }

// 13c) KNOWN regime + a keepable ~50% play + plenty of mana -> KEEP it (no scouting value in a redraw).
//      (the live t10 case: rich mana must NOT toss a 50% play once the pattern is locked). The pool even
//      holds a nominally-better card here, yet a locked regime + keepable play still means keep.
{ const gs = { deckCardData:[card1d,card8], hand:[1,1], discard:[], fullDeck:[1,1,8,8,2,3], playerHp:7, fishHp:8, fishMaxHp:17 };
  const play = { ev:0.5, pHit:0.5, guaranteedCatch:false };
  eq('known regime, 50% play, rich mana -> KEEP (no redraw)', FB._shouldRedraw(gs, play, lockedPr), false);
  // but while the regime is still unknown, the same play is worth redrawing to scout (and the pile is better)
  eq('unknown regime, same 50% play, rich mana -> redraw to scout', FB._shouldRedraw(gs, play, blindPr), true); }

// 14) drawPool = fullDeck - hand - discard (reshuffles when short)
{ const gs = { fullDeck:[1,2,3,4,5,6,7,76,77,79], hand:[76,7,77], discard:[] };
  eq('drawPool computes remaining pile', FB._drawPool(gs).sort((a,b)=>a-b), [1,2,3,4,5,6,79]); }

// 15) lookahead (chooseAction/lookaheadValue) — regression cases pinned to the real 2026-09-01
//     Plankton run (real cards.json stats: 2=[hit456,+5/-3], 76=[8-zone,+3/-3], 77=[critOnly5,+10crit/-3/0hit]).
{ const mk = (id, hit, crit, h, m, c) => ({ id, manaCost:1, hitZones:hit, critZones:crit,
    hitEffects:[{type:'FISH_HP',amount:h}], missEffects:[{type:'FISH_HP',amount:m}], critEffects:[{type:'FISH_HP',amount:c}] });
  const c1=mk(1,[1,2,3],[],5,-3,0), c2=mk(2,[4,5,6],[],5,-3,0), c3=mk(3,[7,8,9],[],5,-3,0),
        c4=mk(4,[1,4,7],[],5,-3,0), c5=mk(5,[2,5,8],[],5,-3,0), c6=mk(6,[3,6,9],[],5,-3,0),
        c7=mk(7,[1,3,7,9],[],6,-3,0), c76=mk(76,[1,2,3,4,6,7,8,9],[],3,-3,0),
        c77=mk(77,[],[5],0,-3,10), c79=mk(79,[2,4,6,8],[],5,-3,0);
  const c16 = mk(16,[1,2,3,4,5,6,7,8,9],[],1,0,0);
  const deckCardData = [c1,c2,c3,c4,c5,c6,c7,c16,c76,c77,c79];
  const fullDeck = [1,2,3,4,5,6,7,16,76,77,79];

  // t1: hand [77,76,2], fishHp13/20, mana5. card76 (75% pHit, 3dmg) beats card77's 25% crit
  // gamble easily (an earlier lookahead version got seduced by the crit shot here because it
  // mixed raw catch-bar points into the same scale as the ±win/loss terminal reward — a
  // scaling bug, since fixed). But card76 vs card2 (50% pHit, 5dmg) is a genuine judgment
  // call, not a bug: the model (verified after making the leaf estimate mana- AND hand-aware,
  // which only widened this gap rather than explaining it away) finds card2 slightly ahead —
  // card76's near-full-board coverage travels well to future turns regardless of where the
  // fish ends up, so banking it while cashing in the more position-sensitive card2 now (still
  // a decent 50%) can beat playing 76 immediately. User-approved 2026-09-01 after review.
  { const hist = [[2,1],[1,2]];
    const pr = FB._predict(hist, {canAlternate:false});
    const gs = { hand:[77,76,2], playerHp:5, focusMeter:3, focusPoint:[2,2], fishHp:13, fishMaxHp:20,
      deckCardData, fullDeck, discard:[3,5,79] };
    const c = FB._chooseAction(gs, hist, pr, true);
    eq('lookahead t1: does not pick the 25% crit gamble card77', c.type==='play' && c.mv.cardId !== 77, true);
    eq('lookahead t1: picks card2 over card76 (banks the flexible card for later)', c.type==='play' && c.mv.cardId, 2); }

  // t2: hand [77,2] only, fishHp10/20, mana4 — forced choice between a 17% instant-kill
  // crit (77) and a 33% partial chip (2) that would need a follow-up. With the win-probability
  // model these come out close (a genuine toss-up, not a blowout either way) — assert both are
  // sane probabilities and neither crashes, rather than pinning an exact winner that could
  // flip on minor position-search tie-breaks.
  { const hist = [[2,1],[1,2],[2,3]];
    const pr = FB._predict(hist, {canAlternate:false});
    const gs = { hand:[77,2], playerHp:4, focusMeter:3, focusPoint:[2,2], fishHp:10, fishMaxHp:20,
      deckCardData, fullDeck, discard:[3,5,79,76] };
    const c = FB._chooseAction(gs, hist, pr, true);
    eq('lookahead t2: returns a play with a bounded [0,1] win probability', c.type==='play' && c.mv.val >= 0 && c.mv.val <= 1, true);
    eq('lookahead t2: is a close call, not a blowout (within 15pp)', Math.abs(c.mv.val - c.redrawVal) < 1 && c.mv.val > 0.3 && c.mv.val < 0.7, true); }

  // bestPositionFor must never favor an outer-ring square over an equally-good central one
  // (user caught this live: card79's plus-shape hit 2/3 candidates from EITHER [1,2] (edge)
  // or [3,2]/[2,3] (interior) — bestPositionFor had dropped decide()'s edgePenalty, so ties
  // were broken by iteration order and it silently picked the edge square every time).
  { const c79 = mk(79,[2,4,6,8],[],5,-3,0);
    const pr = { cand: [{cell:[3,1],p:1/3},{cell:[2,2],p:1/3},{cell:[1,3],p:1/3}] };
    const pos = FB._bestPositionFor(c79, [2,2], 3, pr, 20-13, 20);
    const onEdge = (r,c) => r===1 || r===4 || c===1 || c===4;
    eq('bestPositionFor prefers an interior square over an edge one on a tied play', onEdge(pos.focus[0], pos.focus[1]), false); }

  // chooseAction's per-card position choice must use REAL lookahead value (shortlist re-rank),
  // not just the cheap heuristic — three live-flagged cases the heuristic alone gets wrong,
  // in different directions (undervalues a cheap move; undervalues conserving a scarce last
  // focus point; overvalues conserving it when the payoff is big). No single focus-cost
  // constant, flat or scaled-by-remaining-focus, satisfies all three at once (tried and
  // measured) — only real per-position lookahead does.
  { // case1: card16 at higher-coverage (spend 1 focus) vs staying put (keep focus). This flipped
    // THREE times across three model refinements, and all three flips are legitimate, not flaky:
    //  1) originally "move" under the focus-blind leaf estimate (didn't know spending focus had
    //     any future cost at all);
    //  2) flipped to "stay" once leafEstimate() learned to price focus=0 with a flat 17.6%
    //     stuck-rate constant (spending focus now looked like risking a uniformly-bad future);
    //  3) flipped to "move" once that flat constant was replaced with a composition-aware one --
    //     this deck's pool holds wide-coverage cards, so being stuck looked nowhere near as bad
    //     as the population-average 17.6% assumed;
    //  4) flipped BACK to "stay" once the composition-aware constant itself was recalibrated
    //     against the FULL run dataset (2026-09-09 audit): the real observed stuck hit rate
    //     (0.286, n=28) is much closer to the original flat 17.6%-derived pessimism than step 3's
    //     ~53%-for-a-wide-card estimate was -- being stuck is genuinely bad regardless of which
    //     wide card you'd be stuck with, so spending the focus point to avoid it is worth it again.
    const hist = [[3,4],[2,3]];
    const pr = FB._predict(hist, {canAlternate:false});
    const gs = { hand:[16,2,6], playerHp:6, focusMeter:3, focusPoint:[2,2], fishHp:9, fishMaxHp:15,
      deckCardData, fullDeck, discard:[5,4,3] };
    const c = FB._chooseAction(gs, hist, pr, true);
    eq('shortlist rerank: card16 stays put once the stuck-cost is recalibrated against full-dataset evidence', c.type==='play' && c.mv.cardId===16 && c.mv.moveCost===0, true); }
  { // case2: with only 1 focus left, spending it on a modest 50% gain is worse than staying put
    // (25% now, but keeps the point free for a potentially better future turn) — needs a
    // realistic-sized deck (not the minimal 11-card catalog above): a thin draw pool makes
    // "keep the option open" worth less, which can flip this specific close call.
    const c8=mk(8,[2,4,6,8],[],5,-5,0), c9=mk(9,[1,2,3,4,6,7,8,9],[],2,-4,0), c10=mk(10,[],[5],0,-5,10),
          c29=mk(29,[1,2,3,6,9],[],6,-3,0), c30=mk(30,[7,8,9,1,4],[],5,-3,0), c31=mk(31,[7,8,9,3,6],[],5,-3,0),
          c33=mk(33,[4,5,6],[4,6],5,-3,8), c36=mk(36,[2,5,8],[2,8],5,-3,8), c49=mk(49,[1,4,7],[8],5,-3,8);
    const bigDeck = [c1,c2,c3,c4,c5,c6,c7,c8,c9,c10,c16,c29,c30,c31,c33,c36,c49,c76,c77,c79];
    const bigFullDeck = bigDeck.map(d=>d.id);
    const hist = [[2,1],[4,1]]; // real dist-2 transition (was [4,2], an impossible dist-3 gap for a
                                  // canAlternate:false fish -- only ever silently tolerated because
                                  // predict() used to collapse any non-1 distance to 2; now that it
                                  // uses the real observed distance, an invalid fixture surfaces
                                  // instead of being masked. See threeMoveMinHp's 2026-09-10 change.
    const pr = FB._predict(hist, {canAlternate:false});
    const gs = { hand:[2,7,3], playerHp:5, focusMeter:1, focusPoint:[3,3], fishHp:8, fishMaxHp:16,
      deckCardData: bigDeck, fullDeck: bigFullDeck, discard:[1,4,5] };
    const c = FB._chooseAction(gs, hist, pr, true);
    eq('shortlist rerank: keeps the last focus point rather than a modest 50% gain', c.type==='play' && c.mv.moveCost===0, true); }
  { // mid-game: spending BOTH remaining focus points is worth it here (33%->67% pHit) —
    // confirms the fix doesn't overcorrect into always avoiding a full-focus spend
    const hist = [[1,3],[3,3]];
    const pr = FB._predict(hist, {canAlternate:false});
    const gs = { hand:[7,79,77], playerHp:4, focusMeter:2, focusPoint:[2,2], fishHp:5, fishMaxHp:15,
      deckCardData, fullDeck, discard:[16,2,6] };
    const c = FB._chooseAction(gs, hist, pr, true);
    eq('shortlist rerank: spends both remaining focus points when the payoff is big enough', c.type==='play' && c.mv.cardId===7 && c.mv.moveCost===2, true); }

    // lookaheadValue's per-card position choice must ALSO use shortlist+rerank-by-real-value,
  // not bare bestPositionFor() (which chooseAction's top level was already fixed to avoid, but
  // the recursive path — used by evaluateRedraw() and multi-turn lookahead — still called the
  // raw heuristic). Confirmed live 2026-09-05: a crit-only-lethal card (hit 8 dmg, not enough;
  // crit 10 dmg, lethal) scored only 0.25 (bestPositionFor's generic ev/pHit score parked it on
  // a position covering more predicted cells overall but NOT the crit cell) when the true best
  // reachable position for the SAME card actually lands the crit cell 50% of the time. This
  // silently undervalued a redraw whose only real payoff was reaching this card.
  { const c21 = mk(21,[2,5,8],[1,3],8,-6,10);
    const hist = [[3,3],[3,1],[2,2],[1,1]];   // pins pr.cand to [3,1]:.25, [2,2]:.5, [1,3]:.25
    const state = { hand:[21], mana:1, focus:2, bobber:[3,2], fishHp:9, fishMaxHp:17, hist, canAlt:false };
    const defsMini = { 21: c21 };
    eq('lookaheadValue finds the true 50%-lethal position for a crit-only-lethal card (not 25%)',
      FB._lookaheadValue(defsMini, state, 0), 0.5); }

  // leafEstimate's stuck-rate (focus=0) must be COMPOSITION-AWARE, not one flat constant for
  // every stuck situation: wide coverage must still score strictly higher than narrow. The
  // MAGNITUDE of that gap was recalibrated down (2026-09-09 audit, full-dataset evidence): the
  // real observed stuck hit rate (0.286, n=28) barely differs between wide- and narrow-accessible
  // turns (0.25 at coverage 0.89 specifically, n=24) -- being stuck is bad almost regardless of
  // which card you're stuck with, so a strict >2x gap was itself an artifact of the earlier
  // over-optimistic stuckCoverageSlope, not a real effect. Direction still holds; size doesn't.
  { const wide = mk(16,[1,2,3,4,5,6,7,8,9],[],2,0,0);
    const narrow = mk(1,[1,2,3],[],2,0,0);
    const hist = [[2,2],[2,3]];
    const base = { mana:5, focus:0, bobber:[2,2], fishHp:10, fishMaxHp:20, hist, canAlt:false };
    const wideVal = FB._lookaheadValue({16:wide}, { ...base, hand:[16] }, 0);
    const narrowVal = FB._lookaheadValue({1:narrow}, { ...base, hand:[1] }, 0);
    eq('leafEstimate: stuck with a wide-coverage card scores above stuck with a narrow one', wideVal > narrowVal, true); }

  // leafEstimate (the heuristic used past the real lookahead horizon) must discount for a
  // STRANDED bobber, not just low mana. A focus=0 bobber can never chase the fish's predicted
  // cell again, and measured live it hits at only 17.6% vs 76.7% while still mobile (n=17 vs
  // n=103) -- before this fix, leafEstimate only ever discounted for scarce MANA, so a fight
  // that spent all focus early looked identical (heuristically) to one that kept it, right up
  // until the moment it actually got stuck 3+ turns later, past what the real 2-ply recursion
  // could see. Same non-lethal single-hit scenario, differing ONLY in focus: focus=0 must score
  // meaningfully lower than focus=3.
  { const c1 = mk(1,[1,2,3],[],2,-1,0);
    const defsMini = { 1: c1 };
    const hist = [[2,1],[2,2]];
    const base = { hand:[1], mana:5, bobber:[2,2], fishHp:10, fishMaxHp:20, hist, canAlt:false };
    const stuck = FB._lookaheadValue(defsMini, { ...base, focus:0 }, 0);
    const mobile = FB._lookaheadValue(defsMini, { ...base, focus:3 }, 0);
    eq('leafEstimate: stuck (focus=0) scores well below mobile (focus>0) in an otherwise-identical state', stuck < mobile * 0.5, true); }

// sanity: with no fullDeck on the state, chooseAction falls back to single-turn decide()/shouldRedraw()
  { const hist = [[2,1]];
    const pr = FB._predict(hist, {canAlternate:false});
    const gs = { hand:[76], playerHp:5, focusMeter:3, focusPoint:[2,2], fishHp:13, fishMaxHp:20, deckCardData };
    const c = FB._chooseAction(gs, hist, pr, true);
    eq('lookahead falls back gracefully with no fullDeck', c.type === 'play' || c.type === 'redraw' || c.type === 'none', true); }
}

// 16) depth-3 escalation on close top-level calls (2026-09-09 audit item #5, implemented 2026-09-10):
// chooseAction() re-checks the top-two depth-2 candidates one ply deeper when their gap is under
// cfg.closeCallGap, bounded by cfg.depth3TimeBudgetMs (a cooperative wall-clock deadline
// lookaheadValue() checks and throws LookaheadBudgetExceeded on once spent).
{ const mk = (id, hit, crit, h, m, c) => ({ id, manaCost:1, hitZones:hit, critZones:crit,
    hitEffects:[{type:'FISH_HP',amount:h}], missEffects:[{type:'FISH_HP',amount:m}], critEffects:[{type:'FISH_HP',amount:c}] });
  // deliberately a TINY deck (3 cards) so a real depth-3 recursion stays fast (~80ms measured) --
  // depth-3 cost is highly scenario-dependent (audit: <1s to 443s on real states; confirmed here
  // too, an 8-card version of this same scenario alone took >2s per candidate), so the escalation
  // tests need a cheap, fast-converging scenario to stay deterministic and not slow the suite down.
  const c1=mk(1,[1,2,3],[],5,-3,0), c2=mk(2,[4,5,6],[],5,-3,0), c3=mk(3,[7,8,9],[],5,-3,0);
  const deckCardData = [c1,c2,c3];
  const fullDeck = [1,2,3];
  const defs = {}; deckCardData.forEach(d => defs[d.id] = d);
  const hist = [[2,1],[1,2]];
  const pr = FB._predict(hist, {canAlternate:false});
  const gs = { hand:[1,2], playerHp:5, focusMeter:3, focusPoint:[2,2], fishHp:9, fishMaxHp:20,
    deckCardData, fullDeck, discard:[3] };
  const state = { hand: gs.hand, mana: gs.playerHp, focus: gs.focusMeter, bobber: gs.focusPoint,
    fishHp: gs.fishHp, fishMaxHp: gs.fishMaxHp, hist, fullDeck: gs.fullDeck, discard: gs.discard, canAlt:false };

  // forced trigger (closeCallGap=1.0 always counts as "close") -- confirms the mechanism activates
  FB.config({ closeCallGap: 1.0, depth3TimeBudgetMs: 2000 });
  const c = FB._chooseAction(gs, hist, pr, true);
  eq('depth-3 escalation: fires and marks the result when forced', c.escalated, true);

  // the winning candidate's val must equal a FRESH depth+1 computation on the exact same
  // position/redraw, not just a flag flip -- proves the recursion's own result was substituted
  // in, not merely attempted.
  if (c.type === 'play') {
    const def = defs[c.mv.cardId];
    const candidates = FB._positionsFor(def, gs.focusPoint, gs.focusMeter, pr, gs.fishMaxHp-gs.fishHp, gs.fishMaxHp).slice(0,4);
    let bestPos = null;
    for (const pos of candidates) {
      const v = FB._playValue(defs, def, pos, c.mv.cardId, c.mv.handIdx, state, 2);
      if (!bestPos || v > bestPos.val) bestPos = { pos, val: v };
    }
    const depth3Val = FB._playValue(defs, def, bestPos.pos, c.mv.cardId, c.mv.handIdx, state, 3);
    eq('depth-3 escalation: winning PLAY val matches a fresh depth+1 recomputation', c.mv.val, depth3Val);
  } else if (c.type === 'redraw') {
    const depth3Val = FB._evaluateRedraw(defs, state, 3, gs.hand.length);
    eq('depth-3 escalation: winning REDRAW val matches a fresh depth+1 recomputation', c.val, depth3Val);
  } else {
    eq('depth-3 escalation: forced-trigger scenario resolves to a real decision', c.type, 'play or redraw, not none');
  }

  // an already-exhausted time budget must fall back cleanly to the untouched depth-2 ranking,
  // not crash or hang -- proves the cap actually bounds worst-case cost.
  FB.config({ closeCallGap: 1.0, depth3TimeBudgetMs: -1000 });
  const cTimedOut = FB._chooseAction(gs, hist, pr, true);
  eq('depth-3 escalation: an exhausted time budget aborts cleanly (escalated=false)', cTimedOut.escalated, false);
  eq('depth-3 escalation: timed-out fallback is still a valid decision', ['play','redraw','none'].includes(cTimedOut.type), true);

  // a clearly non-close depth-2 gap must not trigger escalation at all (regression safety —
  // ordinary decisions are unaffected by this feature).
  FB.config({ closeCallGap: 0.0000001, depth3TimeBudgetMs: 2000 });
  const cNotClose = FB._chooseAction(gs, hist, pr, true);
  eq('depth-3 escalation: does not fire when the gap is not close', cNotClose.escalated, false);

  FB.config({ closeCallGap: 0.01, depth3TimeBudgetMs: 2000 }); // restore defaults for any later use
}
