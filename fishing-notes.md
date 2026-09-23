# Gigaverse Fishing — reverse-engineering notes

## Auth
- JWT stored in `localStorage.authResponse` -> `.jwt`
- Send as header: `Authorization: Bearer <jwt>`
- Player wallet: 0x7f9Dc44Ec4EE1E8ccaC4AE04Fd541e4acE0E4942 ; noob docId 81138

## Endpoints (base https://gigaverse.io)
- GET  /api/fishing/cards            -> {entities:[80 card defs]}
- GET  /api/fishing/state/<address>  -> {gameState:{data:{...}}}  (current/last game)
- POST /api/fishing/action           -> body JSON (below), returns {data:{doc:{data:{...}}, events:[...]}, actionToken}

## Action payloads
start_run:
{"action":"start_run","actionToken":"<ms-timestamp>","data":{"cards":[],"nodeId":"5","focusPoint":[],"itemId":0,"slotIndex":0,"tierId":1}}
  - nodeId = pond/node id (string). tierId = difficulty tier. itemId/slotIndex for bait/consumable.
play_cards:
{"action":"play_cards","actionToken":"<ms>","data":{"cards":[0],"nodeId":"","focusPoint":[2,2],"itemId":0,"slotIndex":0,"tierId":0}}
  - cards = array of HAND INDICES to play this turn (mana permitting; multi-card possible)
  - focusPoint = [row,col] 1..4, center of the 3x3 stencil on the 4x4 grid
  - actionToken: echoed from previous response's actionToken (server anti-replay). First one = timestamp.

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

## SELLING FISH / EXCHANGE RATES (verified 2026-09-14)
- Fish are a HELD INVENTORY ITEM (`GET /api/items/balances`, keyed by numeric `ID_CID`), not an
  auto-converted reward. They are sold via the exchange for that pond's resource.
- `exchangeRates` lives at the **TOP LEVEL** of `GET /api/fishing/state/<address>` -- NOT inside
  `gameState.data`. Looking for it in gameState returns an empty array and silently reads as
  "no fish data". Shape: `{id, tier, baseVal, value, pondId}` per species.
- **`baseVal` is a pure function of RARITY** (exact, all 63 species):
  Common 4, Uncommon 10, Rare 30, Epic 60, Legendary 100, Relic 150, Giga 250.
- **`tier` is that day's MARKET RATE for selling a species, not a rarity** (user-confirmed 2026-09-14,
  then verified against all 63 live species -- 60/60 exact for tiers 1-5, rounding is `floor`):
      tier 5 -> x1.50   tier 4 -> x1.25   tier 3 -> x1.00   tier 2 -> x0.75   tier 1 -> x0.50
      tier 0 -> value 0, i.e. NOT SELLABLE that day (seen live on 3 Dungeon Pond species)
  So `value === floor(baseVal * mult(tier))`. **Do NOT conflate `tier` with the 0-6 rarity scale**
  -- they disagree on 54 of 62 species (chance level); Barnaboo is tier 5 yet Common/lowest value.
  An earlier note flagged this as an open question; it is now settled as a NO.
- **It is RANDOM (or semi-random) per day, NOT a rotation or schedule** (user, 2026-09-14) -- do not
  describe it as rotating and do not try to predict which day a species will be high; it can only be
  read from the live `exchangeRates`. It also applies **at the moment of SALE and has nothing to do
  with when the fish was caught**, so holding a fish costs nothing and carries no decay. The upshot:
  the same fish swings **3x between its best and worst day** (x1.5 vs x0.5), so never sell into a
  tier 1-2 day unless you need the resource immediately -- just wait and re-check. `value` is a live
  figure -- re-pull it rather than caching; only `baseVal`, rarity and pond are stable.
- Observed distribution on 2026-09-14 (ONE day, so treat as a hypothesis): of 63 species, tiers 1-5
  held 12/13/11/12/12 and tier 0 held 3. That is suspiciously close to an even 12 per tier, which
  suggests the game ALLOCATES a fixed number of species to each tier each day (a shuffle) rather
  than drawing each species independently. If true, roughly 20% of species sit at tier 5 and ~40% at
  tier 4+ on any given day. Worth confirming by capturing `exchangeRates` on a few more days.
- Expected multiplier if you sell on an arbitrary day is ~0.96 (slightly BELOW base), because tier 0
  and the two discount tiers outweigh the two premium ones. Selling blind is therefore a small loss;
  waiting for tier 4+ is the whole edge, and tier 4+ is ~2.5 days away on average vs ~5.3 for tier 5.
- **TWO PONDS, tracked separately** (each has its own levelling tree and its own sale resource):
  `pondId 1` = **Dungeon Pond** (39 species), `pondId 2` = **Dendren Pond** (24 species -- the one
  this bot fishes). Confirmed two independent ways: each catalog entry's `GUIDE_CID` ("Found in the
  Dendren Pond") and `pondEntryTiers`, whose entries are literally named `dendrenpond-tier1/2/3`
  with `pondId: 2`. Always split any inventory valuation by `pondId`; never sum the two.
- **Species id -> name mapping: `fish-catalog.json`** (in this repo, 63 species with name, rarity,
  rarityId 0-6, size, pondId and baseVal). There is NO API endpoint for this -- every obvious
  `/api/items`-style path 404s. It was extracted from the game's own frontend JS bundle, which
  carries a full item table (`ID_CID`, `NAME_CID`, `RARITY_CID`, `RARITY_NAME`, `TYPE_CID`,
  `SIZE_CID`, `GUIDE_CID`). Re-extract from the bundle if ids ever change. The bundle's
  `RARITY_NAME` values are exactly the 7 tier names already used elsewhere in these notes.

## JEBAITOR = A FREE CAST (user-confirmed 2026-09-18)
- `jebaitorTriggered` (recorded on the CATCH turn of every run JSON, and nowhere else) means **that
  cast does not count against the daily limit** -- it is a throughput refund, NOT a combat bonus.
  The field was previously listed here only as an undocumented state field.
- **Measured rate: 101 of 496 recorded catches = 20.4%.** By mana bar (a rough proxy for
  account/era): manaMax 11 18.8% (n=170), 12 20.0% (n=25), 13 30.8% (n=39), 14 23.2% (n=224).
  The manaMax-10 era shows 0/38, i.e. it was not yet active then.
- **This dwarfs catch-rate tuning.** ~20% of catches being free is worth ~20%+ more fishing per day;
  the entire mana-vs-fintuition skill question below moves catch rate by about 1pp. When the two
  compete for the same slot (gear, skill points), throughput should usually win -- daily cores scale
  with casts, while catch rate only shifts each cast's outcome slightly.
- **Accounting unit confirmed 2026-09-18 (user)**: `maxPerDay` (10) is the UNJUICED cap --
  `maxPerDayJuiced` (not `maxPerDay`) is the real limit for a paid/juiced account, and both bot and
  main accounts are juiced, giving **20 non-jebaitor casts/day**. The daily-cap error's "max runs"
  wording is misleading -- the unit is per FISH/cast, not per multi-fish run. Confirmed against every
  day of viewer data: non-jebaitor cast count clusters tightly at 19-23 (mostly 20-21) on every day
  that actually hit the cap, for both accounts, e.g. main 2026-09-13: 32 total casts - 12 jebaitor =
  20 non-jebaitor exactly. A jebaitor trigger is a straight 1-for-1 refund against this 20-cast budget.
- Gear can boost the jebaitor rate; as of 2026-09-17 the main account swapped its fintuition gear for
  jebaitor gear deliberately, on the reasoning above.

## PULLING SELL VALUE + POND SKILL LEVEL (recipe, 2026-09-15)
To answer "what's my fish inventory worth" / "what's my pond level and cost to level up", pull
live data -- do not estimate or reuse cached numbers, everything here changes daily or with catches.

1. **Get the account's real wallet address first.** `cfg.address` in fishbot-node.js defaults to
   the BOT account's address (`0x7f9Dc44Ec4EE1E8ccaC4AE04Fd541e4acE0E4942`) -- passing that same
   default for the MAIN account (e.g. via `--address=` on a main-account command) silently pulls
   the wrong account's fishing *state* (gameplay actions still go to the right account via the JWT,
   only display/lookup calls using `--address` are affected). The reliable way to get an account's
   true address: call `GET /api/items/balances` with that account's token -- every returned entity's
   `PLAYER_CID` is the real address (no `--address` param needed, balances are keyed to the JWT).
   Main account's real address (confirmed 2026-09-15): `0xbbbfe4cc5c3924f19f6e36e66448b2e3a126b111`
   (matches the "...b111" suffix already used in run-viewer.html labels).
2. **Fetch `GET /api/fishing/state/<realAddress>` with that account's token** (raw fetch, NOT
   `fetchState()` -- that helper only returns `gameState.data` and silently drops everything else
   used here). Grab the top-level `exchangeRates` (per-species `{id,tier,baseVal,value,pondId}`,
   `value` already has today's tier multiplier applied) and `pondRates`.
3. **Per-pond skill level lives in `pondRates`, NOT the top-level `skillLevel` field.** The
   top-level `skillLevel` is pond 1 (Dungeon) only and will silently under-report Dendren's real
   level (confirmed live: top-level read 22 while `pondRates.find(p=>p.pondId===2).skillLevel` read
   76 for the same account at the same instant -- the top-level number is NOT "your fishing level").
   `pondRates` is an array of `{pondId, skillLevel, qualityWeights, unlockLvlsPerQuality, nodes}`;
   find the entry with `pondId:2` for Dendren.
4. **Fetch `GET /api/items/balances` with that account's token** for held fish counts
   (`{ID_CID, BALANCE_CID}` per species, no address param).
5. **Compute sell value**: for each held species (cross-ref `fish-catalog.json` by id, keep only
   `pondId===2` for Dendren), sell value = `exchangeRates[id].value * balance`. This already bakes
   in today's tier multiplier per species -- do not re-apply `baseVal * mult(tier)` on top of it.
6. **Level-up cost table is NOT available from any endpoint found so far** -- the user supplies it
   directly (a per-level cost + cumulative total, e.g. level 71: cost 623, cumulative 623). Treat the
   live `pondRates` skill level as current and only sum the remaining rows from there (levels can
   move between the chart being given and being used -- confirmed live: main was captured at level
   70 in an earlier session, was actually 76 by the time the chart was used the next day; always
   re-pull `pondRates` before applying a cost table, never assume the level the chart started at
   still holds).
7. **Currency assumption, not yet independently confirmed**: sell proceeds and the pond's own
   leveling-cost table are assumed to be the same resource (Sediment) per the "own sale resource"
   note above, since fish are sold specifically for that pond's resource. Flag this assumption when
   reporting a value-vs-cost comparison rather than stating it as settled.

## FISH MOVEMENT (confirmed with user)
- Fish moves EVERY turn (never stays). Pattern is fixed but hidden.
- Distance regime is exactly one of:
  - always-1: moves to an orth-adjacent square, NEVER back to the square it was on last turn (net manhattan 1).
  - always-2: two orthogonal steps, but NEVER back to the square it started this turn (net manhattan 0 excluded; net 2 only).
  - alternating 1-2-1-2 (only ≥21-HP fish — confirmed by user 2026-09-09: 21-HP fish themselves can
    alternate, not just fish strictly above 21; matches `cfg.alternateMinHp: 21` in the code).
  - **3-step moves (only ≥28-HP fish — confirmed live 2026-09-10, lowered from 29 to 28 on
    2026-09-13 after a real 28hp fish showed it, matches `cfg.threeMoveMinHp: 28`):** a fish this
    size CAN take a 3-orthogonal-step move in one turn. NOT every ≥28hp fish uses this — only 3 of
    10 real 28-29hp encounters showed it at all; the rest were ordinary always-1/always-2/
    alternating-1-2, identical to smaller fish. Every confirmed 3-capable fish locked into a clean,
    perfectly regular alternation once measured correctly: 1<->3 (seen twice) or 2<->3 (seen once)
    — never all three, never a fixed "always-3" (sample size is still small, 3 real fish; revisit
    as more are seen, especially whether 27hp or below can ever show it too). **The real signal is
    PATH LENGTH (the API's own `lastMovePath.length`), not net
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
- **How LIKELY each regime is — measured 2026-09-13 over the full 342-cast replay set (1,734 real
  moves, length always from `lastMovePath.length`).** The rules above say what a fish *can* do; these
  are the base rates for what it actually does, and they are what `cfg.moveDistPrior` encodes.
  - **Alternating is a big-fish behaviour, with a hard floor: ≤21hp fish have NEVER been seen to
    alternate.** Not once, in any logged cast — **0 alternators out of 157 ≤21hp fish with ≥4
    observed moves** (enough moves to tell), and 0 of all 240 with ≥2; at exactly 21hp it is 0 of
    31 casts in the replay set (0 of 33 counting segmented run files). **Count FISH, not
    transitions** — alternation is a fixed per-fish property, so an alternator switches on every
    transition and a non-alternator on none; quoting the 816 raw transitions inflates the
    evidence ~3x. 95% upper bound on P(alternating | ≤21hp) is ~1.9% on the fish count, vs the
    ~0.37% a transition count would wrongly imply. Fish ≥23hp alternate in 44 of 108 casts (41%). Restricted to casts long
    enough to *observe* it (≥4 moves): ~0% at 14-21hp vs 42-45% at 22-30hp. This does NOT contradict
    the user's 2026-09-09 confirmation that 21hp fish CAN alternate — see `cfg.moveBandLowMaxHp` — it
    means the hedge there should be ~3% (an asserted-but-never-observed mechanic), not the 25% a flat
    0.75 continuation prior was spending.
  - **First-move distance is close to a coin flip, NOT weighted by path count.** Measured: ≤21hp
    49%/51% (d1/d2), ≥28hp 50%/45%/5% (d1/d2/d3). This mattered a lot — the old opening prediction
    summed the candidate sets without normalizing each distance to its own total, so because a
    3-step walk has ~5x as many distinct paths as a 1-step one, **d=3 was silently collecting
    59-63% of the opening belief on every ≥28hp fish against a real 5% rate.**
  - **How strongly a fish sticks to its distance depends on its size.** Share of first transitions
    that repeated the same distance: ≤21hp **240/240 = 100%** (per fish), 22-27hp 52%, ≥28hp 58%. So small fish
    lock immediately and completely, while big fish are near a coin flip on each move — one flat
    continuation prior for all sizes (the old 0.75) is wrong at both ends.
  - Once locked, a ≤21hp fish stays locked — **absolutely**: no fish has ever been seen to
    break it (0 of 157 fish with ≥4 moves). Hedging this was tried and rejected; see the `!canAlt` branch.
  - ⚠️ **DATA-QUALITY TRAP — segment on TURN-level `fishMaxHp`, never `meta.fishMaxHp`.** Some
    `runs/*.json` files (and 2 of the 342 replay-viewer examples, #7 and #8) concatenate SEVERAL
    fish into one turn list, with `meta` describing only the FIRST fish. Analysed naively they look
    like single casts of 20-58 moves that "switch distance" mid-cast — which is really just two
    different fish's regimes spliced together. This exact artifact produced a bogus "6 lock breaks
    in 2 casts" finding on 2026-09-13 that was then correctly retracted. Split a turn list wherever
    the per-turn `fishMaxHp` changes before computing ANY movement statistic.
- **3-step moves correlate with QUALITY, not just HP** (user's hypothesis, 2026-09-13 — checked and
  it holds). Of 170 catches with quality recorded, every fish that ever took a 3-step move was
  **quality 5**: q5 2/2 three-moved, q1-q4 0/40 at the same ≥28hp sizes. Overall only 5 of 66 ≥28hp
  fish (7.6%) ever three-moved at all. Note 30hp fish showed 0 of 17 — so this is NOT monotonic in
  HP, which is itself evidence the gate is quality rather than size. Caveat before relying on it:
  **quality is only known AFTER the catch**, so it can't be conditioned on mid-cast; and quality is
  nearly collinear with HP anyway (q1 spans 14-21hp, q3 26-30, q4 28-30, q5 28-29), so HP is already
  most of the signal. The actionable part is the base rate: ~8%, not a coin flip. Alternating fish
  are likewise roughly q2+ (q1 is 14-21hp, where alternation is ~1%).
- No on-screen telegraph of the next move.
- To hit: card resolves on the fish's POST-move square, so predict that square (or cover the candidate set).

## Bot design
- Runs IN-BROWSER (console script / userscript) so it reads JWT from localStorage; token never leaves machine.
- Loop: read state -> predict fish next cell -> pick card(s)+focus to cover it (prefer high dmg, mind mana)
  -> POST play_cards with echoed actionToken -> repeat until fishHp<=0 (win) or playerHp<=0 (lose) -> start_run next.

## Escalation gap-check used the wrong value scale (fixed 2026-09-19)
- **Bug**: depth-3 escalation's closeness check (`cfg.closeCallGap`) compared candidates by their
  risk-adjusted `rank`, not raw `val` -- but the actual final play-vs-redraw decision (`return`
  statements at the bottom of `chooseAction`) always compares raw `val` (`redrawVal > bestPlay.val`).
  Redraw's rank is always its raw val (never risk-discounted); a play's rank IS discounted by
  `riskAdjust` whenever it carries real miss risk. Result: a play with meaningful miss chance could
  have a real (raw) gap to redraw well under the 0.01 threshold and still never trigger escalation,
  because the discount inflated the RANK gap past it.
- **Found via a real live loss** (main account, cast #649, 2026-09-19, a 29hp fish that cascaded to
  5 misses in a row): turn 4's raw gap was 0.0079 (should escalate), rank gap was 0.047 (didn't).
  Full manual depth-3 on that exact state found redraw (0.819) clearly beats the depth-2 answer of
  playing card109 (0.733) -- a real, meaningful miss, not a marginal one.
- **Fix**: keep sorting `cands` by rank (still needed to pick the CORRECT top-2 -- this is the
  2026-09-14 fix already documented below, still required), but check closeness using raw `val`.
  Verified: full regression suite (106/106) unaffected; the exact cast #649 T4 state now triggers
  escalation where it silently didn't before.
- **Follow-on problem, fixed same day**: `cfg.depth3TimeBudgetMs` (was 15000ms, user-approved
  2026-09-10 as a live-turn-latency cap) was too tight for this specific case to actually COMPLETE
  once escalation correctly triggers -- it needed ~59s uncapped, so in production it triggered,
  timed out, and silently fell back to the original (still-wrong) depth-2 answer anyway. User
  explicitly prioritized decision quality over turn latency 2026-09-19 ("more than we have been") --
  raised to 90000ms. Verified: the exact cast #649 T4 state now resolves end-to-end under production
  defaults in ~48s, correctly picking redraw (0.819) over the old depth-2 answer of playing (0.733).
- **New instrumentation (2026-09-19)**: turn snapshots now record `escalated` / `escalationAttempted`
  / `escalationTimedOut` -- previously NOT persisted anywhere, so there was no way to answer "how
  often does escalation actually trigger/time out live" from historical data. Query these across
  future runs before further tuning `depth3TimeBudgetMs` or `closeCallGap`, rather than reasoning
  from a single example again.

## Gear durability, repair, and Restore (reverse-engineered live, 2026-09-23)
- Equipped fishing gear (Head/Body/Charm/Rod/Lure, found via the in-game "Forest Shrine -> Equipment
  -> Forbidden Woods Gear" screen) has real durability that drops with use, separate from every
  other resource (mana, focus, energy). **Confirmed empirically: exactly -1 durability per CAST
  (one fish, win or lose), no exceptions observed** -- not per turn, not per game/chain.
- Two real, previously-undocumented API endpoints (found via live browser network capture, not
  guessed):
  - `GET /api/account/<address>` -- account-level summary (username, Noob NFT, checkpoint
    progress, and a cosmetic `equipment` block for Body/Head SKIN slots -- these are `TYPE_CID:
    "Skin"` items with no durability, a completely different system from the fishing gear below;
    don't confuse the two).
  - `GET /api/gear/instances/<address>` -- every gear instance the account owns, each with
    `GAME_ITEM_ID_CID` (which item), `DURABILITY_CID` (current durability), `RARITY_CID` (0-6),
    `EQUIPPED_TO_SLOT_CID` (`-1` = not equipped), `REPAIR_COUNT_CID` (repairs already used on THIS
    instance).
  - `GET /api/gear/items` -- the static gear catalog: `NAME_CID`, `DURABILITY_CID_array` (max
    durability indexed BY RARITY -- e.g. Puppeteer's Rod is `[40,44,50,60]`, so an Epic (rarity 3)
    one maxes at 60, confirmed exactly against the in-game `[47/60]` display), `repairCost`
    (`INPUT_ID_CID_array`/`INPUT_AMOUNT_CID_array` for a normal repair, `RESET_INPUT_ID_CID_array`/
    `RESET_INPUT_AMOUNT_CID_array` for Restore -- always item 250, "Gear Ember"), and
    `REPAIR_COUNT_CID` -- **max repairs allowed is NOT a flat 3 for everything** (same field name
    as the instance's "repairs used", different meaning on this endpoint) -- confirmed 5 for
    Head/Body armor, 3 for Ring/Rod/Lure.
- **`POST /api/gear/repair`** -- repairs one instance. Requires `{"gearInstanceId": "<docId>"}` in
  the body -- an empty body genuinely 500s with `"Gear instance not found"` (confirmed live), so
  this is NOT a "whatever's equipped" endpoint, it targets one exact instance. The correct field
  name (`gearInstanceId`) was only found by trying candidates directly against the live API after
  browser network capture showed an empty body -- the real client likely serializes this at a
  layer below `window.fetch` that page-level interception can't see. Repairing does NOT restore to
  full durability -- confirmed it goes to a fixed value (durability 0 -> 20 for a Twin Lure whose
  rarity-0 max is also 20, i.e. it happened to be full in that case; needs more data points to know
  if repair always sets full-for-current-rarity or some other fixed amount) and increments
  `REPAIR_COUNT_CID` by 1.
- **`POST /api/gear/restore`** -- same request shape (`{"gearInstanceId": ...}`), used once repairs
  are maxed out. **Restore REROLLS the item's rarity** (confirmed live: a Rare Twin Lure rolled
  down to Common) -- it is not a neutral reset, it's a gamble on top of spending Gear Ember. Resets
  `REPAIR_COUNT_CID` to 0 and sets durability to the new rarity's max.
- **Auto-repair is wired into the bot** (`cfg.autoRepairGear`, default ON -- user-directed
  2026-09-23 as standing behavior, unlike oils/tier2-3 rings which stay opt-in-per-run):
  `checkAndRepairGear()` runs before EVERY `start_run` call in `playGame()` (both the first fish of
  a game and every subsequent fish in the same chain -- not just once per batch), so a durability
  hit mid-batch gets repaired before the next cast, not just at the top. It repairs any equipped
  item at exactly 0 durability with repairs remaining; if repairs are maxed, it only WARNS (never
  auto-restores -- that stays a manual, deliberate action given the rarity-reroll gamble above).
  The pure decision part (`decideGearActions`) is unit-tested offline in `test.js`.

## Escalation UX: `--maxTurnMs`, and making the pause legible (2026-09-23)
- Live telemetry (n=608 real play-turns, 2026-09-20/21/22) showed escalation is attempted on
  ~55-60% of turns, not the rare edge case it was assumed to be -- and ~27% of attempts run out
  the full `depth3TimeBudgetMs` budget and time out. That means a first-time user could plausibly
  see a multi-second-to-90s pause on every other turn, with (before this date) zero terminal
  output explaining why -- indistinguishable from a hang to anyone who hasn't read this file.
- `--maxTurnMs=N` is a friendlier CLI alias for `cfg.depth3TimeBudgetMs` (any cfg field was already
  settable via `--fieldName=value`, but that internal name gives no hint what it does). Documented
  in both READMEs' flag lists.
- Three log additions (all user-requested, same date) make the tradeoff legible instead of silent:
  1. A startup message (once, in `run()`) explains what the pause is, that it's normal (not a
     bug), that `--maxTurnMs` controls it, and what a lower value actually costs.
  2. A live notice the MOMENT a close call triggers escalation (inside `chooseAction`, before the
     potentially-long recompute starts) -- was completely silent before this.
  3. A resolution notice right after -- either "done in Xs, used the deeper check" or "gave up
     after Xs, used the faster answer instead" -- so a lower `--maxTurnMs`'s actual effect is
     demonstrated in the moment it happens, not just described in the abstract.
  4. An end-of-batch summary (in `run()`, before the final `done:` line) tallying attempted/used/
     timed-out counts across the whole batch, so a user has real numbers from their OWN run to
     decide whether to change `--maxTurnMs` next time.
- None of this changes the default (still 90000ms / 90s) or the escalation logic itself -- purely
  visibility. Full regression suite (106/106) unaffected.
- **Follow-up same day**: the timeout RATE was answerable from existing telemetry (27.2% of
  attempts, n=342, 2026-09-20/21/22), but how long a SUCCESSFUL escalation actually takes was not
  -- the elapsed time only ever existed in the live "done in Xs" log line, never persisted. Added
  `escalationMs` alongside the existing `escalated`/`escalationAttempted`/`escalationTimedOut`
  turn-snapshot fields (set in `chooseAction`, threaded through both turn-snapshot construction
  sites in `playGame`) so this becomes queryable from real data too. Note: on a TIMED-OUT turn,
  `escalationMs` is ~= `depth3TimeBudgetMs` by construction (the deadline that just fired), not a
  meaningful "how long would this actually have taken" measurement -- only trust this field's
  distribution on `escalated:true` turns for answering "how long does escalation usually take when
  it doesn't time out." No data exists yet as of this writing -- first numbers come from the next
  live batch run under this build.

## leafEstimate ignored redraw cost entirely (fixed 2026-09-22)
- **Bug**: `leafEstimate`'s affordability math (`mana / playsNeeded`) implicitly assumed every future
  mana point buys a PLAY at `cfg.expectedHitRate`. It had zero model of redraws, even though
  redraws are a real, roughly-constant ~35% of ALL turns regardless of fish size (measured
  32.8%-37.2% across HP bands, not meaningfully fish-size-dependent -- 2026-09-22 audit, n=4029
  real turns pooled across every recorded live game). Since redraw rate is ~constant per turn but
  bigger fish need more total turns, the absolute mana this omission missed scaled with turns-needed
  even though the rate didn't -- so the blind spot cost the most on exactly the fish that need the
  most turns to land.
- **Investigated after a user-flagged pattern**: a small sample (n=5, the main account's 28-30hp
  losses on 2026-09-21/22) looked redraw-heavy (36-71% of mana spent on redraws per loss). That
  did NOT replicate at scale -- across the full 28-30hp dataset (n=208 fights), losses actually had
  a LOWER redraw rate than same-band wins (27.5% vs 35.3%) and lower mana-fraction-on-redraws
  (46.7% vs 54.2%). The small sample was noise on that specific axis. What DID hold at scale:
  winning 28-30hp fights already spend close to the full 14-mana budget in the tail (p95 mana-used
  == 14, 25.3% of wins use >=12/14) -- this band's mana margin has little real slack even when
  everything goes right, so ANY unmodeled tax (like the constant-rate redraw tax above) erodes an
  already-thin buffer. Losses also showed real bad luck on top of that: offered pHit 60.6% vs wins'
  73.2%, and realized hit rate UNDER their own offered odds by -16.8pp (wins ran +9.3pp OVER their
  offered odds) -- so losses are a mix of tougher spots and genuinely cold variance, not purely a
  modeling bug; no code change eliminates that variance (there is no mid-fight flee action).
- **Fix**: `leafEstimate` now amortizes the redraw tax into an effective mana cost per unit of
  progress: `effectiveManaCostPerPlay = avgPlayManaCost + (r/(1-r)) * avgRedrawManaCost`, where
  r = `cfg.redrawRateEstimate` (0.351), `avgRedrawManaCost` (2.377), `avgPlayManaCost` (0.924) are
  all measured constants (see cfg comment, same n=4029 pooled audit). `totalManaNeeded =
  playsNeeded * effectiveManaCostPerPlay` replaces the old `playsNeeded` directly in the
  affordability ratio.
- **Backtested against real data before shipping** (927 real play-turn snapshots across all 28-30hp
  fights): the correction is universally more conservative (87 snapshots crossed from affordable
  >=0.5 to tight <0.5, zero crossed the other way) and NOT a flat shift -- average affordability
  drop was larger in loss-bound turns (-0.078) than win-bound turns (-0.052), and the 87 newly-
  flagged risky turns were enriched for real losses (32.2% eventual loss rate vs 24.0% baseline for
  the band). Full regression suite passes 106/106 (one test's hardcoded play-vs-redraw winner at
  mana=4 legitimately flipped -- an edge case its own 2026-09-01 comment already called "could flip
  on minor tie-breaks"; widened to check whichever side won rather than pin one).
- **Revert path**: `cfg.redrawRateEstimate=0` + `cfg.avgPlayManaCost=1` reproduces the exact
  pre-fix formula (verified in the backtest script). Since `fishbot-node.js`'s CLI maps any
  `--flagName=value` straight onto `cfg` (see the CLI entry point), this is revertible with no code
  change: `node fishbot-node.js --redrawRateEstimate=0 --avgPlayManaCost=1 ...`. A full pre/post
  file backup also sits in `gigaverse-fishbot-backups/2026-09-22_1014/`.
- **Not yet live-validated** -- shipped after backtesting against historical data, but no live runs
  have used it yet as of this writing (main account was at its daily cap when this landed). Watch
  the next several days of 28-30hp results before treating the backtest signal as confirmed.

## Card-selection risk aversion (user-directed investigation, 2026-09-14)
- The recursive win-probability search sometimes picked a genuinely weak card (e.g. 10% pHit)
  over a clearly stronger one in the SAME hand (e.g. 50% pHit), because playing the weak card
  kept the strong one in hand for a hypothetical future turn. Confirmed in two real casts and, on
  mining every real turn's logged `handEval`, found on 88 real turns -- fish where this happened
  lost far more than fish that didn't, in every HP band (low 79.6% vs 92.0% win, mid 70.0% vs
  77.8%, high 36.8% vs 94.4%), though this is correlational.
- Fix: `cfg.riskAversionWeight` (0.5) discounts a candidate PLAY's ranking score by its own P(miss)
  -- but ONLY when choosing which card/position to play, never when deciding whether to play at
  all. The value that competes against redraw is always the true, undiscounted one. Validated
  offline against 863 real turns: hit-rate 72.2%->74.8%, and catch-bar progress per mana spent
  (the metric that actually matters, since mana is the hard constraint) 1.762->1.931 (+9.6%),
  holding in every band, with play/redraw counts essentially unchanged (not just "redraw more").
  0.5 came from a weight sweep (0-1.0) that showed a real peak there, not a monotonic trend.
- Integrating it surfaced a real bug: depth-3 escalation (cfg.closeCallGap) was still selecting and
  comparing its top-2 candidates by TRUE value, not risk-adjusted -- capable of silently re-picking
  the pre-fix answer on close calls. Fixed to use the same risk-adjusted ranking throughout. See
  the cfg.riskAversionWeight comment in fishbot-node.js for full detail.
- NOT yet validated with a live run -- offline replay only.

## Pond tiers & rings (user, 2026-09-11)
- Fishing at Tier 2 or Tier 3 (`tierId` in `start_run`'s payload; the bot's `cfg.tierId`/`--tierId=`
  flag, default 1) requires spending a ring: **Silver ring for Tier 2, Gold ring for Tier 3**. In
  exchange, Tier 2 doubles hard-cores rewards and Tier 3 quadruples them (see "Catch rewards" below).
- Which ring type is in stock/available rotates on a daily schedule that isn't documented anywhere the
  user has access to — don't assume a given ring is available on a given day.
- **Not yet verified live**: whether `start_run` auto-consumes the matching ring from inventory when
  `tierId>1`, what error it returns if the account doesn't own the needed ring, or whether a ring must
  be equipped via some other action first. Treat a Tier 2/3 request as a real, limited resource spend
  (same caution as oils) until this is confirmed — watch for a ring-related rejection the same way
  `"Player has reached max runs for fishing"` (daily cap) and `"Not enough energy"` are already handled
  as distinct, named error strings.

### "Not enough energy" (user-confirmed 2026-09-22)
- Energy is a **separate resource from the daily cast cap** -- each `start_run` game costs 12 energy,
  regenerates over time (regen rate not yet measured), and can also be topped up from a ROM (an
  in-game item NFT the user owns). NOT the same limit as "Player has reached max runs for fishing" --
  the two can trigger independently, and hitting energy exhaustion does not mean the daily cast cap is
  also reached (confirmed live 2026-09-22: hit energy-exhaustion after only 22 attempts that day, well
  under the usual ~19-23-to-cap range, though those ranges may partly overlap -- not enough data yet to
  say how the two interact).
- Current bot behavior on this error: treated as fatal (`run()`'s try/catch, see the `catch (e)` block
  around the main game loop) -- exports whatever was caught so far, then stops the whole batch. It does
  NOT wait for regen or attempt to use a ROM automatically. Since energy regenerates and ROMs exist,
  a batch stopped this way may be resumable later (unlike a real daily-cap stop) -- ask the user how
  they want to handle it (wait and retry, spend a ROM, or leave it) rather than assuming it's done for
  the day. Spending a ROM is a real limited-resource action -- same caution as oils/tier2-3 rings, never
  do it without being asked.

## Catch rewards: rarity, quality, hard cores (user-verified 2026-09-11)
- Every catch has a `rarity` (0-6) and `quality` (1-5) on its `catchDetails`, tracked separately from
  Sediment. Rarity names, 0-indexed: Common, Uncommon, Rare, Epic, Legendary, Relic, Giga.
- A separate reward called **hard cores** is NOT present in any captured `loot` response (confirmed
  absent from raw API data via a `DEBUG_LOOT=1` capture) — it's tracked entirely server-side/elsewhere,
  not something the bot can currently read directly. The formula below was reverse-engineered from
  user-supplied verified game-data tables, not from bot telemetry, and cross-validated against 3
  independent real reward figures with zero rounding error.
- **Formula**: `cores = rarityCoresBase[rarity][pondTier] * qualityMultiplier[quality]`.
  - Rarity base at Tier 1 (doubles per pond tier — Tier2=×2, Tier3=×4): Common 80, Uncommon 160,
    Rare 320, Epic 400, Legendary 480, Relic 560, Giga 640. **Not a single clean progression** —
    doubles for the first two bumps (Common→Uncommon→Rare) then flattens to a flat +80/tier for the
    rest. Don't assume it's geometric or arithmetic if extending this table.
  - Quality multiplier: q1=1, q2=2, q3=4, q4=5, q5=6. Also not linear/geometric — doubles twice then
    flattens to +1.
- Implemented in run-viewer.html (the Dendren Pond Replay artifact) and the daily-report artifacts as
  `RARITY_CORES_BASE`/`QUALITY_MULT`/`coresFor()`.
