---
name: gigaverse-fishing
description: Run and analyze a bot for the Gigaverse fishing minigame (gigaverse.io) — automates the catch-bar minigame via its real API, and maintains a visual replay viewer of past runs. Use when the user asks to fish, run fish, catch fish, check fishing stats, or work on the Gigaverse fishing bot in this project.
---

# Gigaverse Fishing Bot

This skill operates a working bot for Gigaverse's fishing minigame (gigaverse.io) and maintains a
visual "replay" viewer of past runs. The bot engine (`fishbot-node.js`) is a tested, live-validated
Node CLI — read it before changing anything; don't reimplement the decision logic from scratch.

## Files in this skill

- `fishbot-node.js` — the bot engine + CLI. Run fish, chain multiple fish, handles oils. See its
  header comment for setup/usage.
- `cards.json` — universal card catalog (id -> mana/hit-zones/crit-zones/damage). Not account-specific.
- `sim.js` — generates offline demo replays by running the real engine against scripted fish, for
  testing/demoing the viewer without touching the live API.
- `test.js`, `test-run.js`, `test-token.txt` — unit + offline integration tests. Run `node test.js`
  and `node test-run.js` after any engine change; both must stay green.
- `run-viewer.html` — the "Dendren Pond Replay" viewer: an interactive turn-by-turn visualization of
  past fish (grid, predicted fish positions, hand, catch bar). Ships blank (a "no runs recorded yet"
  message) — every real run gets added here as it happens (see below). `sim.js` can regenerate a set
  of synthetic demo fish if you want to see the viewer populated without a live account.
- `fishing-notes.md` — reverse-engineered API/mechanics reference (endpoints, action payloads, state
  fields, oil item catalog, movement model). Read this before guessing at API behavior.
- `README.md` — setup instructions for a first-time user (getting a token, finding your address).
- `LICENSE.md` — PolyForm Noncommercial 1.0.0. Free for noncommercial use; commercial use needs the
  copyright holder's permission first. Mention this if anyone asks about reuse/licensing.

## CRITICAL: terminology

**Always say "catch bar", never "fish HP" or "heal"/"healing".** The catch bar (`fishMaxHp - fishHp`
in the raw API) fills toward a catch on a hit and drains toward an escape on a miss. Never describe a
miss as "healing" the fish, in code, in the viewer, or in conversation with the user — the API field
is still literally named `fishHp` (don't rename it in code), but everything *said* about it, written
to a file, or shown in the UI must use catch-bar language. This applies to ALL communication about
this project, not just code or UI text — including your own chat responses while using this skill.

## Standing rules

- **"a run" / "one run" = ONE FISH** (one time through the pond), not a whole multi-fish chain. When
  asked for "a run" or "one run", pass `--maxFish=1`.
- **Never handle, type, or relay the user's JWT/token yourself.** If a token is missing or expired,
  tell the user how to get a fresh one (see README.md) and have them save it to the token file
  themselves. Passing a JWT value on the command line or typing it into chat is never appropriate,
  even if the user offers it directly.
- **Do not start or drive a live run without the user's explicit go-ahead** — this hits a real
  account's real daily fishing cap.
- **Always add every completed live run to the replay viewer afterward, without being asked.**
  Workflow: after a run finishes, `fishbot-node.js` writes `runs/run-<timestamp>.json`. Read it, then
  splice a new entry into `run-viewer.html`'s `EXAMPLE_DATA` block (the JSON object between
  `/*__EXAMPLES__*/` and `/*__END__*/`) using that run's `meta`/`gridSize`/`cards`/`turns`. If a run
  covers multiple fish (a multi-`caught` batch under one `--maxFish=N>1` call), split it into one
  viewer entry per fish (segment `turns` at each `caught` boundary) rather than one giant entry.
- **Never fabricate or infer a movement/behavior pattern beyond what's documented in
  `fishing-notes.md`.** The fish's movement regime (always-1 / always-2 / alternating) has no further
  pattern within it — no direction bias, no cycle. Don't "discover" one.

## Running the bot

```
node fishbot-node.js --maxFish=1 --address=0xYOUR_WALLET
```

See `fishbot-node.js`'s header comment and `README.md` for full setup (token file, finding your
address, running against a second account). The bot refuses to start without `--address` set.

## Oils

The bot can use fishing oils mid-fight via the real `use_fishing_item` action (see
`fishing-notes.md`'s "Fishing oils" section for the full mechanism — there's no pre-fight "equip"
step; any oil in account inventory can be used any time, capped at 3 uses/fight server-side).

**Oils are OFF by default and never spent without the user opting in for that specific run.**
Running the CLI interactively (a real terminal, not piped/scripted) prompts before every run:
whether to use oils at all, which item id, and the minimum hit-chance trigger. Answering no (or just
pressing enter) leaves oils off. In a non-interactive session with no oil flags given, it logs a note
and leaves oils off rather than prompting (would otherwise hang waiting for input that never comes).
`--useOils=true --oilItemId=... --oilPHitThreshold=...` on the command line skips the prompt entirely
for scripted use. Never flip `cfg.useOils` to `true` by default in code, and never answer the prompt
or pass `--useOils=true` on the user's behalf without them telling you to — it spends their real,
limited inventory.

When enabled, current behavior (`oilItemId`/`oilPHitThreshold` in `fishbot-node.js`) is narrowly
scoped: it only considers the one item id configured (defaults to Big Dual Yield Oil, item 972), and
only uses it the turn a catch looks both likely (hit chance ≥ the configured threshold, default 75%)
and imminent (that card's plain hit damage alone would zero the catch bar this turn) — i.e. it
rations the oil rather than spending it early. Extend this deliberately if asked to use multiple oil
types in one run or a different trigger condition; don't just widen the existing check without being
asked to.

## Testing changes

Before considering any engine change done: `node test.js && node test-run.js` — both must stay fully
green. `test-run.js` mocks the network entirely (no live calls, safe to run any time). If you add a
new network call to `fishbot-node.js`, check whether `test-run.js`'s `global.fetch` mock needs a new
case for it (see the `/api/items/balances` special-case in that file for an example of a call that
needed its own mock branch rather than falling through to the generic one).

## Extending the bot

Read the relevant section of `fishing-notes.md` first — a lot of mechanics here were hard-won through
live experimentation (movement model, redraw economics, oil mechanism) and are easy to get subtly
wrong by reasoning from first principles alone. If you need to find a real API action name or payload
shape that isn't documented, don't guess against the live API — see "Finding real action names /
payloads" in `fishing-notes.md` for the technique that actually works (downloading and grepping the
game's own public JS bundles), which is much faster and doesn't risk live account state.
