# Gigaverse Fishing — reverse-engineering notes

## Auth
- JWT stored in `localStorage.authResponse` -> `.jwt`
- Send as header: `Authorization: Bearer <jwt>`
- See README.md for how to get your own token/address — never hardcode or share a real one here.

## Endpoints (base https://gigaverse.io)
- GET  /api/fishing/cards            -> {entities:[80 card defs]}
- GET  /api/fishing/state/<address>  -> {gameState:{data:{...}}}  (current/last game)
- POST /api/fishing/action           -> body JSON (below), returns {data:{doc:{data:{...}}, events:[...]}, actionToken}
- GET  /api/items/balances           -> {entities:[{ID_CID, BALANCE_CID, ...}]}  (full inventory by item id, incl. oils)

## Action payloads
start_run:
{"action":"start_run","actionToken":"<ms-timestamp>","data":{"cards":[],"nodeId":"5","focusPoint":[],"itemId":0,"slotIndex":0,"tierId":1}}
  - nodeId = pond/node id (string). tierId = difficulty tier. itemId/slotIndex/tierId here have NO
    effect on oils (see "Fishing oils" section below) — this was a wrong early guess, disproven live.
play_cards:
{"action":"play_cards","actionToken":"<ms>","data":{"cards":[0],"nodeId":"","focusPoint":[2,2],"itemId":0,"slotIndex":0,"tierId":0}}
  - cards = array of HAND INDICES to play this turn (mana permitting; multi-card possible)
  - focusPoint = [row,col] 1..4, center of the 3x3 stencil on the 4x4 grid
  - actionToken: echoed from previous response's actionToken (server anti-replay). First one = timestamp.
use_fishing_item (fishing oils — see "Fishing oils" section below):
{"action":"use_fishing_item","actionToken":"<ms>","data":{"cards":[],"nodeId":"","focusPoint":[],"itemId":973,"slotIndex":0,"tierId":0}}
  - itemId = the oil's item id (see catalog below). slotIndex = which of the 3 per-fight consumable
    slots to fill (0/1/2, must be a currently-unused slot). tierId's effect is unverified — 0 always
    worked live regardless of the item's actual rarity tier.

## State fields (gameState.data)
playerMaxHp(7), playerHp, fishHp, fishMaxHp(e.g 20), fishPosition[r,c], previousFishPosition[r,c],
gridSize(4 -> 4x4 grid, coords 1..4), focusPoint[r,c], focusMeter/focusMeterMax(0..3),
focusMechanicEnabled, patternIndex, fullDeck[ids], nextCardIndex, cardInDrawPile, hand[cardIds],
discard[cardIds], jebaitorTriggered, consumablesUsed, fishingConsumableSlotUsed[3], day, week,
lastMovePath[zoneA,zoneB] (0-indexed 4x4 zones), caughtFish{...}, deckCardData[card defs]

## Card model (deckCardData / cards.entities)
{id, manaCost, hitZones[1..9], critZones[1..9], hitEffects[{type,amount}], missEffects, critEffects, rarity, foundInPonds}
- hitZones are positions in a 3x3 stencil numbered:
    1 2 3
    4 5 6
    7 8 9
- Basic cards: 1=row[1,2,3] 2=row[4,5,6] 3=row[7,8,9] 4=col[1,4,7] 5=col[2,5,8] 6=col[3,6,9] 7=corners[1,3,7,9] (6dmg)
- Effects: hit FISH_HP +5 (damage), miss FISH_HP -3 (fish heals). Crits stronger.

## HIT RULE (confirmed)
- Order per turn: FISH_MOVES first, then card resolves.
- Stencil centered at focusPoint (fr,fc). Zone z (1..9): dr=floor((z-1)/3)-1, dc=((z-1)%3)-1; cell=(fr+dr, fc+dc).
- Covered cells = { cell(z) for z in card.hitZones }.
- HIT if fish's POST-MOVE cell in covered cells (=> +5 dmg). Otherwise MISS (=> fish +3 hp / heal).
- Since focus is free, ANY predicted target cell can be covered by choosing focus = target - zoneOffset.
  => Game reduces to PREDICTING the fish's next cell (+ managing playerHp; you lose HP over turns).

## FISH MOVEMENT (confirmed with user)
- Fish moves EVERY turn (never stays). Pattern is fixed but hidden.
- Distance regime is exactly one of:
  - always-1: moves to an orth-adjacent square, NEVER back to the square it was on last turn (net manhattan 1).
  - always-2: two orthogonal steps, but NEVER back to the square it started this turn (net manhattan 0 excluded; net 2 only).
  - alternating 1-2-1-2 (only ≥21-HP fish — confirmed by user 2026-09-09: 21-HP fish themselves can
    alternate, not just fish strictly above 21; matches `cfg.alternateMinHp: 21` in the code).
  - **3-step moves (only ≥29-HP fish — confirmed live 2026-09-10, matches `cfg.threeMoveMinHp: 29`):**
    a fish this size CAN take a 3-orthogonal-step move in one turn. NOT every ≥29hp fish uses this —
    only 2 of 9 real 29hp encounters showed it at all; the rest were ordinary always-1/always-2/
    alternating-1-2, identical to smaller fish. The two confirmed 3-capable fish each locked into a
    clean, perfectly regular alternation once measured correctly: one alternated 1<->3, the other
    2<->3 — never all three, never a fixed "always-3" (sample size is tiny, 2 real fish; revisit as
    more are seen). **The real signal is PATH LENGTH (the API's own `lastMovePath.length`), not net
    Manhattan displacement between positions** — a 3-step path can double back and land only 1 or 2
    squares from where it started, so reading net displacement alone silently misclassifies some
    3-step moves as 1-step ones. This is a parity fact, not a modeling choice: 3 orthogonal unit
    steps can only ever net to a Manhattan distance of 1 or 3, NEVER 0 or 2 (each axis needs an even
    step-count to net to zero on that axis, and two even numbers can't sum to the odd total of 3).
    The no-backtrack rule generalizes the same way as always-2's: no step may reverse the step
    immediately before it, checked at every step of the walk, not just the first.
- WITHIN a regime, a 1-move destination is genuinely uniform among the legal squares (only one path
  reaches each). A 2-move destination is NOT uniform, though — CORRECTED 2026-09-09 audit: a
  "diagonal" square (two independent orthogonal steps) is reachable via TWO path combinations
  (right-then-up or up-then-right) while a straight two-in-a-row square has only ONE, so diagonal
  squares are genuinely twice as likely. Confirmed against the full runs/ dataset: path-count
  weighting beats a uniform assumption at ΔlogL +12.0 (n=154 real 2-move transitions; 110 observed
  diagonals vs 104.5 predicted by weighting, 80.3 by uniform). The code (`reachableWeighted()`)
  already does this correctly — this note previously claimed uniform-among-legal-squares for ALL
  regimes, which was wrong for the 2-move case specifically. No direction bias, position/vector
  cycle, or oscillation on top of this weighting — never infer one. Fish max-HP is likewise random
  per fish, no pattern.
- No on-screen telegraph of the next move.
- To hit: card resolves on the fish's POST-move square, so predict that square (or cover the candidate set).

## Fishing oils (consumables)
- 21 real items: 3 rarity tiers (Lil=Uncommon, Mid=Rare, Big=Epic) x 7 effects (Draw, Relaxing, Mana,
  Fintuition, Crit, Focus, Dual Yield). Item ids (found via the game's own public `_next/static/chunks/*.js`
  bundles — see "Finding real action names" below): Lil = 818(Draw) 819(Relaxing) 821(Mana) 822(Fintuition)
  823(Crit) 824(Focus) 973(Dual Yield); Mid = 936-942 in the same order, +962(Dual Yield); Big = 943-949
  in the same order, +972(Dual Yield).
- **There is no pre-fight "equip" step for oils, confirmed live.** `GET /api/fishing/state` has no
  equipped-oil field (only post-use fields: `fintuitionOilBoostPercent`, `dualYieldOilBoostPercent`,
  `consumablesUsed`, `fishingConsumableSlotUsed[3]`). `start_run`'s response DOES carry a real
  equipped-loadout array (`data.doc.GEAR_CID_array`), but it's scoped to `TYPE_CID:"Gear"`/`"Skin"`
  only (rod/ring/lure/cosmetics) — oils are `TYPE_CID:"Consumable"` and never appear in it. **Any oil
  sitting in account inventory (`GET /api/items/balances`) can be used at any time via `use_fishing_item`,
  completely independent of any in-game "equip" UI** — that UI is a client-side convenience only.
- Hard cap: exactly 3 `use_fishing_item` calls per fight, enforced server-side (`fishingConsumableSlotUsed[3]`,
  `consumablesUsed`). A 4th attempt returns 400 `"Max consumables used this game (3)"`.
- Confirmed effects: Dual Yield Oil gives a persistent "+N% Dual Yield (this game)" boost (Lil=20%,
  Mid=40%, confirmed live; Big unverified numerically but same mechanism). Focus Oil gives an immediate
  "+3 Focus" restore. Draw Oil draws one extra card into hand for free (no mana cost).

## Pond tiers & rings (user, 2026-09-11)
- Fishing at Tier 2 or Tier 3 (`tierId` in `start_run`'s payload — see "Action payloads" above; the
  bot's `cfg.tierId`/`--tierId=` flag, default 1) requires spending a ring: **Silver ring for Tier 2,
  Gold ring for Tier 3**. In exchange, Tier 2 doubles hard-cores rewards and Tier 3 quadruples them
  (see "Catch rewards" below). Rings are almost certainly the `TYPE_CID:"Gear"` ring slot already
  visible in `start_run`'s response (`data.doc.GEAR_CID_array` — see "Fishing oils" above, which notes
  this array covers rod/ring/lure/cosmetics).
- Which ring type is in stock/available rotates on a daily schedule that isn't documented anywhere the
  user has access to — don't assume a given ring is available on a given day.
- **Not yet verified live**: whether `start_run` auto-consumes the matching ring from inventory when
  `tierId>1`, what error it returns if the account doesn't own the needed ring, or whether a ring must
  be equipped via some other action first. Treat a Tier 2/3 request the same way as oils below (a
  real, limited resource spend) until this is confirmed — watch for a ring-related rejection the same
  way `"Player has reached max runs for fishing"` (daily cap) and `"Not enough energy"` are already
  handled as distinct, named error strings.

## Catch rewards: rarity, quality, hard cores (user-verified 2026-09-11)
- Every catch has a `rarity` (0-6) and `quality` (1-5) on its `catchDetails`, tracked separately from
  Sediment. Rarity names, 0-indexed: Common, Uncommon, Rare, Epic, Legendary, Relic, Giga.
- A separate reward called **hard cores** is NOT present in any captured `loot` response (confirmed
  absent from raw API data via a `DEBUG_LOOT=1` capture) — it's tracked entirely server-side/elsewhere,
  not something the bot can currently read directly. The formula below was reverse-engineered from
  user-supplied verified game-data tables, not from bot telemetry, and cross-validated against 3
  independent real reward figures with zero rounding error.
- **Formula**: `cores = rarityCoresBase[rarity][pondTier] * qualityMultiplier[quality]`.
  - Rarity base at Tier 1 (doubles per pond tier — Tier2=×2, Tier3=×4, see "Pond tiers & rings" above):
    Common 80, Uncommon 160, Rare 320, Epic 400, Legendary 480, Relic 560, Giga 640. **Not a single
    clean progression** — doubles for the first two bumps (Common→Uncommon→Rare) then flattens to a
    flat +80/tier for the rest. Don't assume it's geometric or arithmetic if extending this table.
  - Quality multiplier: q1=1, q2=2, q3=4, q4=5, q5=6. Also not linear/geometric — doubles twice then
    flattens to +1.
- Implemented in the replay viewer and the (unpublished/local-only) daily-report artifacts as
  `RARITY_CORES_BASE`/`QUALITY_MULT`/`coresFor()`.

## Finding real action names / payloads (method note)
Browser-context `fetch()`/`XMLHttpRequest` monkey-patching (`window.fetch = ...`) reliably FAILS to
intercept this app's own network calls, even right after a fresh page reload — its bundled HTTP client
doesn't reference `window.fetch`/`XHR` in a patchable way, and Service Worker interception is blocked
too (no way to host a same-origin SW script file without your own deployment). **What actually works:
download the site's own public `_next/static/chunks/*.js` files directly (plain HTTP GET, no auth, no
browser needed) and grep them for action-name enums / relevant identifiers.** In an authenticated
browser tab, `[...document.scripts].map(s=>s.src)` lists the chunk URLs actually in use for the current
route (the public landing-page chunks alone don't include authenticated-game code) — fetch those with
plain Node and grep offline. This is how `use_fishing_item`, `flee`, `cancel_run`, `start_run`,
`play_cards`, `move_focus_point`, `heal_or_damage`, and the full oil-item catalog were all found.

## Bot design
- Runs as a standalone Node CLI (fishbot-node.js) reading a JWT from a local token file you create
  yourself; the token never leaves your machine and this project never asks for or logs it.
- Loop: read state -> predict fish next cell -> pick card(s)+focus to cover it (prefer high dmg, mind mana)
  -> POST play_cards with echoed actionToken -> repeat until fishHp<=0 (win) or playerHp<=0 (lose) -> start_run next.
