// Generate AUTHENTIC sample runs by driving the real bot engine (predict/decide/shouldRedraw)
// against scripted fish (closed movement loops) + the player's real deck.
// Output: examples.json = {examples:[...]}.  Usage: node sim.js > examples.json 2> sim-summary.txt
const fs = require('fs');
const FB = require('./fishbot-node.js'); // fishbot.js is deprecated/frozen -- see its header comment
const CARDS = JSON.parse(fs.readFileSync(__dirname + '/cards.json', 'utf8'));

const G = 4, inB = (r,c)=>r>=1&&r<=G&&c>=1&&c<=G;
const zc = FB._zoneCell;
function def(id){ const [mana,hit,crit,hA,mA,cA]=CARDS.cards[id];
  return { id, manaCost:mana, hitZones:hit, critZones:crit,
    hitEffects:[{type:'FISH_HP',amount:hA}], missEffects:[{type:'FISH_HP',amount:mA}], critEffects:[{type:'FISH_HP',amount:cA}] }; }
const cellsFor=(zones,b)=>zones.map(z=>zc(z,b[0],b[1])).filter(c=>inB(c[0],c[1]));
const DECK = CARDS._deck.slice();
const deckDefs = [...new Set(DECK)].map(def);

function simulate({name, start, loop, fishMax}){
  let drawPile = DECK.slice(), discard = [], hand = [];
  const draw=n=>{ while(n-->0){ if(!drawPile.length){ drawPile=discard; discard=[]; } if(drawPile.length) hand.push(drawPile.shift()); } };
  const refill=()=>draw(3 - hand.length);
  refill();
  let bob=[2,2], focus=3, mana=7, fishHp=fishMax-7;      // fish start with ~7 of the catch bar filled
  const canAlt = fishMax > 21;                            // only >21-HP fish can alternate
  const clamp=v=>Math.max(0,Math.min(fishMax,v));
  const run={ meta:{node:"5",tier:1,result:null,fish:name,fishMaxHp:fishMax,manaMax:7,focusMax:3,canAlt},
    gridSize:G, cards:{}, turns:[] };
  deckDefs.forEach(d=>run.cards[d.id]={mana:d.manaCost,hit:d.hitZones,crit:d.critZones});
  const hist=[start.slice()];

  for(let t=0; t<14; t++){
    if(fishHp<=0){ run.meta.result='win'; break; }
    if(fishHp>=fishMax){ run.meta.result='loss'; break; }   // catch bar emptied -> escape
    if(mana<=0){ run.meta.result='loss'; break; }
    const cur=hist[hist.length-1];
    const gs={ deckCardData:deckDefs, hand:hand.slice(), fishPosition:cur.slice(),
      focusPoint:bob.slice(), focusMeter:focus, playerHp:mana, playerMaxHp:7,
      fishHp, fishMaxHp:fishMax, focusMeterMax:3 };
    const pr=FB._predict(hist, {canAlternate:canAlt});
    const best=FB._decide(gs,pr);
    const path=loop[t % loop.length], landing=path[path.length-1];

    // ---- REDRAW branch (paid; fish still moves, no catch-bar change) ----
    if(FB._shouldRedraw(gs, best)){
      const cost=hand.length;
      run.turns.push({ n:t, action:'redraw', hand:hand.slice(), redrawCost:cost,
        fishBefore:cur.slice(), path:path.map(c=>c.slice()), fishAfter:landing.slice(),
        bobberFrom:bob.slice(), bobber:bob.slice(), moveCost:0,
        predicted:pr.cand.map(c=>c.cell), predictedExact:pr.exact, why:pr.why,
        card:null, covered:[], critCells:[], result:'redraw',
        fishHpBefore:fishHp, fishHp, mana:mana-cost, focus });
      discard.push(...hand); hand=[]; mana-=cost; refill();
      hist.push(landing.slice());
      continue;
    }
    if(!best){ run.meta.result='stuck'; break; }

    // ---- PLAY branch ----
    const d=def(hand[best.handIdx]);
    const amt=FB._effectAt(d, best.focus[0], best.focus[1], landing);
    const critCells=cellsFor(d.critZones,best.focus), covered=cellsFor(d.hitZones,best.focus);
    const inSet=(set,c)=>set.some(x=>x[0]===c[0]&&x[1]===c[1]);
    const result = inSet(critCells,landing)?'CRIT':inSet(covered,landing)?'HIT':'miss';
    run.turns.push({ n:t, action:'play', hand:hand.slice(), playedHandIdx:best.handIdx,
      fishBefore:cur.slice(), path:path.map(c=>c.slice()), fishAfter:landing.slice(),
      bobberFrom:bob.slice(), bobber:best.focus.slice(), moveCost:best.moveCost,
      predicted:pr.cand.map(c=>c.cell), predictedExact:pr.exact, why:pr.why,
      card:{id:d.id,mana:d.manaCost,hit:d.hitZones,crit:d.critZones}, covered, critCells,
      pHit:+(best.pHit||0).toFixed(2), result, fishHpBefore:fishHp,
      fishHp:clamp(fishHp-amt), mana:mana-d.manaCost, focus:focus-best.moveCost });
    fishHp=clamp(fishHp-amt); mana-=d.manaCost; focus-=best.moveCost; bob=best.focus.slice();
    hand.splice(best.handIdx,1); if(!hand.length){ discard.push(); refill(); }   // empty hand -> free redraw
    hist.push(landing.slice());
  }
  if(!run.meta.result) run.meta.result = fishHp<=0?'win':'turn-cap';
  process.stderr.write(`${name} (max ${fishMax}${canAlt?', can-alt':''}): ${run.meta.result} in ${run.turns.length} — `+
    run.turns.map(t=>t.action==='redraw'?'R':t.result[0]+(t.moveCost?'*':'')).join(' ')+
    ` | focus ${focus} mana ${mana} fishHp ${fishHp}\n`);
  return run;
}

// ---- three scripted fish as CLOSED movement loops ----
const oneMove = { name:"Loopfin · 1-move", start:[2,2], fishMax:20, loop:[
  [[2,3]], [[3,3]], [[3,2]], [[2,2]] ] };                                   // 20hp -> can't alternate

const twoMove = { name:"Snakeeel · 2-move", start:[1,1], fishMax:22, loop:[
  [[1,2],[1,3]], [[2,3],[3,3]], [[3,2],[3,1]], [[2,1],[1,1]] ] };            // 22hp

const altMove = { name:"Tidewisp · alternating 1-2", start:[2,2], fishMax:24, loop:[
  [[2,3]], [[3,3],[4,3]], [[4,2]], [[3,2],[2,2]] ] };                        // 24hp -> may alternate

// mirrors the live boundary fish: 21hp (canAlt flag ON) but actually moves always-1
const reef21 = { name:"Reef21 · 1-move (21hp, canAlt)", start:[4,2], fishMax:21, loop:[
  [[4,3]], [[3,3]], [[3,4]], [[4,4]], [[4,3]], [[3,3]], [[3,2]], [[4,2]] ] };

const examples = [oneMove, twoMove, altMove, reef21].map(simulate);
process.stdout.write(JSON.stringify({ examples }));
