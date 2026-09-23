// Offline integration test: mock the network and drive FishBot.run() through a full
// run (plays, a forced redraw, a catch -> loot -> next fish). Verifies request SHAPES
// (start_run / play_cards[idx] / play_cards[] redraw / loot[bestId]) without any live call.
const fs = require('fs');
const sent = [];                                   // captured outgoing action requests

// --- card defs used by the mock deck ---
const CARDS = JSON.parse(fs.readFileSync(__dirname + '/cards.json','utf8')).cards;
const def = id => { const [mana,hit,crit,hA,mA,cA]=CARDS[id];
  return { id, manaCost:mana, hitZones:hit, critZones:crit,
    hitEffects:[{type:'FISH_HP',amount:hA}], missEffects:[{type:'FISH_HP',amount:mA}], critEffects:[{type:'FISH_HP',amount:cA}] }; };
const deckDefs = [1,2,3,4,5,6,7,8,9,10].map(def);

// --- scripted mock game state ---
let S, fishNo, forcedEmptyHandUsed;
function freshFish(hp){ return { deckCardData:deckDefs, playerMaxHp:13, playerHp:S?S.playerHp:13,
  fishHp:hp, fishMaxHp:20, fishPosition:[2,2], previousFishPosition:[2,2], gridSize:4,
  focusPoint:[2,2], focusMeter:3, focusMeterMax:3, focusMechanicEnabled:true, patternIndex:0,
  fullDeck:[1,2,3,4,5,6,7,8,9,10], nextCardIndex:3, cardInDrawPile:7, hand:[8,1,2], discard:[],
  lastMovePath:[6,5], caughtFish:null, cardsToAdd:null }; }
const moveFish = () => { S.previousFishPosition=S.fishPosition.slice();
  S.fishPosition=[S.fishPosition[0], S.fishPosition[1]===1?2:1]; };   // wiggle within board

function respond(state){ lastIssued = String(++tokenSeq);   // issue a fresh token; next action must echo it
  return { ok:true, status:200,
  json: async()=>({ success:true, message:'ok', data:{ doc:{ data:state }, events:
    state.__lastKind==='HIT'?[{type:'HIT',value:5}]:state.__lastKind==='CRIT'?[{type:'CRIT',value:9}]:[] }, actionToken:lastIssued }),
  clone(){ return this; }, text: async()=>'' }; }

let tokenSeq = 5000, lastIssued = null; const tokenViolations = [];
global.fetch = async (url, init) => {
  // items/balances is a real, separate endpoint (GET /api/items/balances) outside the fishing
  // action-token sequence entirely -- confirmed live 2026-09-10 it needs no actionToken at all.
  // Must be special-cased BEFORE the generic GET fallback below, which (correctly, for actual
  // fishing state fetches) mints a fresh token on every call -- routing this through it would
  // desync the fishing action-token sequence for an endpoint that was never part of it.
  if (typeof url === 'string' && url.includes('/api/items/balances')) {
    return { ok: true, status: 200, json: async () => ({ entities: [{ ID_CID: '972', BALANCE_CID: 3 }] }), clone() { return this; }, text: async () => '' };
  }
  // gear/instances + gear/items: same "outside the action-token sequence" reasoning as
  // items/balances above -- checkAndRepairGear() calls these before every start_run. Empty
  // entities means decideGearActions() finds nothing equipped/at-0, so this is a clean no-op for
  // every existing test (none of them assert anything about gear).
  if (typeof url === 'string' && (url.includes('/api/gear/instances/') || url.includes('/api/gear/items'))) {
    return { ok: true, status: 200, json: async () => ({ entities: [] }), clone() { return this; }, text: async () => '' };
  }
  if (init && init.method === 'POST') {
    const body = JSON.parse(init.body); sent.push(body);
    const a = body.action, d = body.data;
    // simulate the server's action-token check: every action must echo the last issued token
    if (lastIssued != null && String(body.actionToken) !== String(lastIssued)) tokenViolations.push({ a, got: body.actionToken, want: lastIssued });
    if (a === 'start_run') { S = freshFish(8); fishNo = (fishNo||0) + 1; return respond(S); }
    // Real client's loot call claims the card only — it does NOT start the next fish (confirmed
    // by live network capture: the real "pick card -> Leave" loot request always sends EMPTY
    // nodeId/tierId, and the resulting state has no active fight). The bot now calls start_run
    // SEPARATELY afterward when it wants to continue (mimicking "Big Cast") — see below.
    if (a === 'loot') { S = Object.assign({}, S, { cardsToAdd: null }); return respond(S); }
    if (a === 'play_cards') {
      if (!d.cards || d.cards.length === 0) {            // REDRAW
        S.playerHp -= (S.hand||[]).length; S.hand=[3,4,5]; moveFish(); S.__lastKind='miss';
      } else {                                           // PLAY one card
        S.playerHp -= 1; S.fishHp -= 5; S.__lastKind='HIT';
        S.hand = S.hand.filter((_,i)=>i!==d.cards[0]);
        if (!forcedEmptyHandUsed && fishNo===1) { S.hand=[]; forcedEmptyHandUsed=true; }  // force a redraw next turn
        moveFish();
        if (S.fishHp <= 0) { S.caughtFish={name:'Testfish',gameItemId:1}; S.cardsToAdd=[def(1),def(14),def(9)]; }
      }
      return respond(S);
    }
  }
  return respond(S || freshFish(8));                     // GET /state
};

// offline integration test against fishbot-node.js (the sole maintained engine -- fishbot.js is
// a frozen/deprecated browser-console snapshot, see its header comment). jwt() reads a real file
// via fs.readFileSync even with fetch mocked below, so point it at a dummy fixture token instead
// of depending on a real (gitignored, per-user) token.txt existing.
const FB = require('./fishbot-node.js');

let pass=0, fail=0; const ok=(n,c)=>{ console.log((c?'PASS ':'FAIL ')+n); c?pass++:fail++; };

(async () => {
  FB.config({ maxGames:1, maxFish:2, maxTurns:20, delayMs:0, verbose:false, tokenFile:'test-token.txt' });
  await FB.run();

  const actions = sent.map(s => s.action + '(' + JSON.stringify(s.data.cards) + ')');
  ok('sent a start_run first', sent[0].action==='start_run');
  ok('start_run carried nodeId & tierId', sent[0].data.nodeId==='5' && sent[0].data.tierId===1);
  const redraws = sent.filter(s=>s.action==='play_cards' && s.data.cards.length===0);
  ok('performed at least one REDRAW (play_cards cards:[])', redraws.length>=1);
  const plays = sent.filter(s=>s.action==='play_cards' && s.data.cards.length===1);
  ok('played single cards by hand index', plays.length>=1 && plays.every(p=>typeof p.data.cards[0]==='number'));
  ok('every play_cards carried a focusPoint (bobber)', sent.filter(s=>s.action==='play_cards').every(s=>Array.isArray(s.data.focusPoint)));
  const loots = sent.filter(s=>s.action==='loot');
  ok('LOOT drafted after a catch', loots.length>=1);
  // the drafted card must be the top of rankDraft over the offered set [1,14,9]
  const best = FB.rankDraft([def(1),def(14),def(9)])[0].id;
  ok('loot picked the top-ranked offered card ('+best+')', loots[0] && loots[0].data.cards[0]===best);
  ok('loot payload has cards:[id] and EMPTY nodeId/tierId (matches real "Leave" — loot never auto-continues)',
    loots[0] && loots[0].data.cards.length===1 && loots[0].data.nodeId==='' && loots[0].data.tierId===0);
  const startRuns = sent.filter(s=>s.action==='start_run');
  ok('a SEPARATE start_run follows loot when continuing (mimics "Big Cast")', startRuns.length>=2);
  ok('every start_run carries the real nodeId/tierId', startRuns.every(s=>s.data.nodeId==='5' && s.data.tierId===1));
  ok('action tokens are chained (no mismatches)', tokenViolations.length===0);
  if (tokenViolations.length) console.log('  token violations:', JSON.stringify(tokenViolations.slice(0,3)));
  console.log('\nactions:', actions.join('  '));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})();
