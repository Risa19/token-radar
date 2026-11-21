# token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Risa19/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Risa19/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Token Radar: a radar for token launches that have not happened yet. It reads a sealed snapshot of every protocol DefiLlama tracks, finds the ones that record no token, ranks them by an implied value priced off the market itself, and shows a reader how to farm each one.

The model (radar-2) prices each protocol at its category's median market-cap-to-TVL among the live tokens already trading in it — shrunk toward the global median, so a thin category cannot set an extreme price — then adjusts for seven-day growth, for how long the protocol has run with no token, and for how many chains it spans. No protocol name is special-cased: the same function scores every row, and the same function derives every farm plan from the protocol's category, chains, TVL and age. Live-token protocols are set apart in their own view, with the mcap/TVL ratios the model prices against.

The board covers the whole 40-protocol watchlist and adds every other rankable pre-token protocol in the snapshot — 203 rows in all. The dashboard is a static page with no network: search, category and chain filters, a watchlist-only toggle, sortable columns, a per-protocol detail view with the value breakdown and a six-step farm plan, and a model panel that states the formula and every constant.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to>/snapshot.json
```

Then open `out/dashboard/index.html` in a browser. Requires Node.js 22.18 or later; standard library only, nothing to install.

---

<sub>Entered on [make.fun](https://make.fun/?ref=jwcak1yj&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
