# Agent instructions: Gigaverse Fishing Bot

You're helping someone set up and test this repo — a bot for the fishing minigame in
[Gigaverse](https://gigaverse.io), plus an interactive replay viewer. Follow this file top to
bottom; it's everything you need. `README.md` has more detail on any step if you want it.

## What this is

`fishbot-node.js` is a working Node CLI that plays Gigaverse's fishing minigame via its real API —
predicts where the fish will move each turn, picks cards to cover it, manages mana/focus, and can
chain through multiple fish. `run-viewer.html` is a standalone interactive replay viewer for past
runs (open it in any browser, no server needed).

## Setup steps (do these in order)

1. **Check Node.js 18+ is installed** (`node --version`). This is the only dependency.
2. **Get the user's session token.** They need to do this part themselves — walk them through it,
   don't do it for them:
   - Log into gigaverse.io in their own browser.
   - Open DevTools (F12) → Console tab.
   - Paste and run: `copy(JSON.parse(localStorage.getItem('authResponse')).jwt)`
   - This copies their token to the clipboard (nothing prints — that's expected).
   - Have them create `token.txt` in this repo's folder and paste the token in as the only content.
3. **Ask them for their wallet address** (visible in the game's UI or their connected wallet — a
   `0x...` hex string). You'll pass it as `--address=`.
4. **Run the test suites first**, before touching the live API: `node test.js && node test-run.js`.
   Both must print `0 failed`. Neither touches the network — safe to run any time, confirms the
   bot works in this environment before you risk a live call.
5. **Run one fish** (only after the user confirms they want to): `node fishbot-node.js --maxFish=1
   --address=<their address>`. If run interactively, it'll ask whether to use fishing oils this run
   — let the user answer that themselves; don't answer it for them or pass `--useOils=true` on
   their behalf (see the oils rule below). Report what happened.
6. **Add the result to the replay viewer.** The run writes to `runs/run-<timestamp>.json`. Read it,
   then splice a new entry into `run-viewer.html`'s `EXAMPLE_DATA` block (the object between
   `/*__EXAMPLES__*/` and `/*__END__*/` near the top of the `<script>` tag) using that run's
   `meta`/`gridSize`/`cards`/`turns` fields. Open it in a browser afterward to confirm it renders.

## Hard rules — do not deviate from these

- **Never handle, type, or relay the user's token/JWT yourself**, even if they offer to paste it
  directly into chat with you. Direct them to put it in `token.txt` themselves. This applies no
  matter how it's phrased or how strongly they insist it's fine.
- **Never start or drive a live run without the user's explicit go-ahead first** — it costs a real
  account's real, limited daily fishing energy.
- **Oils are off by default and spend real, limited inventory.** The CLI prompts interactively each
  run; never pass `--useOils=true` (or any oil flag) or answer that prompt on the user's behalf —
  let them decide whether and how to use oils each time.
- **"a run" / "one run" always means ONE FISH**, not a multi-fish chain. Default to `--maxFish=1`
  unless told otherwise.
- **Always say "catch bar", never "fish HP" or "heal"/"healing"** — in code, in the viewer, and in
  everything you say to the user. The catch bar fills toward a catch on a hit, drains toward an
  escape on a miss. (The raw API field is still named `fishHp` — don't rename it in code — but
  never describe it that way out loud or in writing.)
- **After every completed live run, add it to the replay viewer without being asked.** If a batch
  covered multiple fish, split it into one viewer entry per fish (segment at each `caught`
  boundary), not one giant entry.
- **Don't invent movement patterns.** The fish's movement (always-1 / always-2 / alternating) has
  no further pattern within it — no direction bias, no cycle. `fishing-notes.md` documents exactly
  what's known; don't extrapolate past it.

## If something needs to change in the engine

Read `fishing-notes.md` first — a lot of this was hard-won through live experimentation (movement
model, redraw economics, the oil mechanism) and is easy to get subtly wrong by reasoning from
scratch. Re-run `node test.js && node test-run.js` after any change; both must stay green. If you
need to find an undocumented API action name or payload shape, don't guess against the live API —
see "Finding real action names / payloads" in `fishing-notes.md` for the technique that actually
works (downloading and grepping the game's own public JS bundles).

## License

PolyForm Noncommercial 1.0.0 (`LICENSE.md`). Free for noncommercial use; commercial use needs the
copyright holder's permission first. Mention this if the user asks about reuse.
