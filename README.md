# Gigaverse Fishing Bot

An autonomous bot for the fishing minigame in [Gigaverse](https://gigaverse.io), plus an interactive
replay viewer for reviewing past runs. Reverse-engineered from the game's real API — no client
modification, no automation-detection risk beyond normal API use, nothing installed in your browser.

The bot picks cards and positions a targeting reticle each turn to predict where the fish will move,
manages your mana/focus budget, redraws when the odds are bad, and can chain through multiple fish
automatically, drafting a new card after each catch.

> **Using an AI coding agent to try this out?** Point it at
> [`AGENTS.md`](AGENTS.md) — it has everything needed to set up and run this end to end.

## What's in this repo

| File | What it does |
|---|---|
| `fishbot-node.js` | The bot itself — a Node CLI you run from a terminal. |
| `run-viewer.html` | An interactive HTML replay viewer — open it in any browser, no server needed. |
| `cards.json` | The game's card catalog (damage, mana cost, hit zones). |
| `fishing-notes.md` | Full reference: API endpoints, state fields, movement mechanics, item/oil catalog. |
| `sim.js` | Generates offline demo runs (no live account needed) for testing the viewer. |
| `test.js`, `test-run.js` | Automated tests — run these after changing the engine. |
| `.claude/skills/gigaverse-fishing/SKILL.md` | Instructions for Claude Code, if you're using it to run/extend this bot. |

## Requirements

- [Node.js](https://nodejs.org) 18 or later (for built-in `fetch`).
- A Gigaverse account with some fishing energy.

## First-time setup

The bot authenticates the same way your browser does — with a session token (JWT) from your own
logged-in browser session. **This project never asks for, stores, or transmits your token anywhere
except directly to gigaverse.io's own API**; it lives in a local file you create yourself.

### 1. Get your session token

1. Log into [gigaverse.io](https://gigaverse.io) in a normal browser.
2. Open DevTools (F12, or right-click → Inspect) and go to the **Console** tab.
3. Paste this and press Enter:
   ```js
   copy(JSON.parse(localStorage.getItem('authResponse')).jwt)
   ```
   This copies your session token to the clipboard. (Nothing is printed — that's expected.)
4. Create a file named `token.txt` in this project's folder, and paste the token into it as the
   only contents (no quotes, no extra text).

Tokens expire periodically — if you start seeing `401 Unauthorized` errors, repeat these steps to
refresh `token.txt`.

### 2. Find your wallet address

Your wallet address is visible in the game's own UI (usually near your profile/account info), or in
your connected wallet extension. It looks like `0xAbC123...` (a 42-character hex string).

### 3. Run it

```bash
node fishbot-node.js --maxFish=1 --address=0xYOUR_WALLET
```

This runs exactly one fish and stops. Useful flags:

- `--maxFish=N` — how many fish to play in total (default 6). A loss doesn't stop the batch early —
  it just starts a fresh game and keeps going until N fish have actually been played, or the
  account's daily fishing cap is hit.
- `--maxGames=N` — optional extra safety cap on how many separate games it's allowed to start along
  the way (default: no cap — the fish total and the daily cap are the real limits).
- `--address=0x...` — your wallet address (**required**).
- `--tokenFile=path` — use a different token file (for a second account — see below).
- `--tierId=N` — pond tier to fish at (default 1). Tier 2 and Tier 3 require spending a Silver or
  Gold ring respectively (which ring type is in stock rotates daily), but double/quadruple the hard
  cores reward for every catch (see `fishing-notes.md`). Auto-consumption/rejection behavior for a
  missing ring isn't verified yet — try it and see what error comes back if you don't have one.
- `--useOils=true --oilItemId=... --oilPHitThreshold=...` — skip the interactive oil prompt and use
  oils with these settings directly (for scripted/non-interactive runs). Leave these unset to be
  asked each time you run it in a real terminal.
- `--maxTurnMs=N` — how long (ms) the bot may spend re-checking a genuinely close play-vs-redraw call
  one ply deeper before giving up and using its faster answer instead (default 90000 = 90s). Most
  turns are instant; this only matters on close calls. Lower it for snappier turns at the cost of
  occasionally missing a close-call improvement, or raise it to favor decision quality over speed.
- `--autoRepairGear=false` — turn off automatic gear repair/restore before each cast (default: on).
  With it on, equipped gear at 0 durability gets repaired automatically, and Restored (a rarity
  reroll, not a neutral reset — see `fishing-notes.md`) once repairs are maxed out.
- `--continueOnBrokenGear=true` — if a needed Restore can't be afforded, the default is to stop the
  batch cleanly so you can go get materials. Pass this to keep fishing anyway with that item still
  broken (0 durability) instead of stopping.

Each run writes a JSON log to `runs/run-<timestamp>.json` (created automatically).

### Running a second account

Create a second token file the same way (e.g. `token-alt.txt`), then:

```bash
node fishbot-node.js --maxFish=1 --address=0xOTHER_WALLET --tokenFile=token-alt.txt
```

## Reviewing runs: the replay viewer

Open `run-viewer.html` directly in a browser (double-click it, or drag it into a browser window — no
server required). It ships blank ("no runs recorded yet") until you add your first real run. Want to
see it populated first without a live account? Run `node sim.js > examples.json` to generate demo
fish from scripted movement patterns, then splice `examples.json`'s content into the `EXAMPLE_DATA`
block the same way real runs get added (below).

To add a real run you just played: open the run's JSON file from `runs/`, and splice a new entry into
`run-viewer.html`'s `EXAMPLE_DATA` block (the object between `/*__EXAMPLES__*/` and `/*__END__*/`
near the top of the `<script>` tag) using that run's `meta`/`gridSize`/`cards`/`turns` fields. If
you're using Claude Code with this repo's bundled skill, just ask it to add your latest run to the
viewer and it'll do this for you.

## Testing

```bash
node test.js       # unit tests — pure logic, no network
node test-run.js   # integration test — mocks the network entirely, drives a full simulated run
```

Both should print `0 failed` at the end. Safe to run any time; neither touches the live API.

## How it works (short version)

Each turn, the game moves the fish to one of a few possible squares on a 4×4 grid, then your played
card's shape either lands on that square (a hit, filling the catch bar) or misses (draining it back
out, i.e. the fish getting away). The bot predicts the set of squares the fish could land on given its
movement pattern so far, picks a card + target position that covers as many of them as possible, and
uses a multi-turn lookahead (not just this turn's odds) to decide whether to play or redraw. Full
mechanics — the exact movement rules, catch-bar math, mana/focus economy, and the real API this all
runs on — are documented in `fishing-notes.md`.

## Safety notes

- Your token file(s) (`token*.txt`) and `runs/` (your personal run history) are already listed in
  `.gitignore` — don't remove them from it if you fork/publish your own copy of this repo.
- This bot only calls the same public API endpoints your browser already calls when you play
  manually. It doesn't bypass any client-side checks or use anything not observable in normal
  gameplay traffic.

## License

[PolyForm Noncommercial 1.0.0](LICENSE.md) — free to use, modify, and share for any noncommercial
purpose. Commercial use requires reaching out to the copyright holder first (see LICENSE.md).
