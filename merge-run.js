// Split a raw run-JSON file (from runs/*.json) into individual casts via cast-split.js, and build
// each one's replay-viewer example object -- the piece that used to get recreated ad hoc every
// time and, on 2026-09-14, shipped a real bug because of it: meta was built as
// Object.assign({}, g.meta, {fishMaxHp: overridden, ...}) but canAlt/canThree were NEVER
// overridden, so every split cast past the first in a chain kept the FIRST fish's canAlt/canThree
// regardless of its own fishMaxHp -- a 30hp fish could end up stamped canAlt:false, directly
// contradicting its own turns' "why: regime alternating" text. Both fields are now always
// recomputed here from the cast's OWN fishMaxHp against the live cfg thresholds, never inherited.
const fs = require('fs');
const path = require('path');
const { splitCasts } = require('./cast-split.js');
const FB = require('./fishbot-node.js');

// account: display name exactly as used elsewhere in the viewer, e.g.
//   'Bot account (autonomousnoob)'  or  'Main account (…b111)'
// day: 'YYYY-MM-DD' for the in-game fishing day this run belongs to.
function buildEntries(runPath, account, day) {
  const raw = JSON.parse(fs.readFileSync(runPath, 'utf8'));
  const g = Array.isArray(raw) ? raw[0] : raw;
  const mtime = fs.statSync(runPath).mtimeMs;
  const parts = splitCasts(g.turns, g.meta.fishMaxHp);
  return parts.map(part => {
    let cd = null, caught = null;
    for (const t of part.turns) { if (t.catchDetails) cd = t.catchDetails; if (t.caught) caught = t.caught; }
    const won = !!caught;
    const meta = Object.assign({}, g.meta, {
      fish: won ? caught : null,
      fishMaxHp: part.fishMaxHp,
      canAlt: part.fishMaxHp >= FB.cfg.alternateMinHp,
      canThree: part.fishMaxHp >= FB.cfg.threeMoveMinHp,
      result: won ? 'win' : 'loss',
      label: 'Live · ' + account + ', ' + (won ? 'WIN ' + caught + ' ' + part.fishMaxHp + 'hp' : 'LOSS') + ' (' + day + ')',
      day, dayMtime: mtime, account,
    });
    if (cd) { meta.catchQuality = cd.quality; meta.catchRarity = cd.rarity; }
    else { delete meta.catchQuality; delete meta.catchRarity; }
    return { meta, gridSize: g.gridSize, cards: g.cards, turns: part.turns };
  });
}
module.exports = { buildEntries };
