# Vendored files

Kept in the repo so the worker deploys with no install step. None of them is
edited.

| Path | What | From | License |
| --- | --- | --- | --- |
| `resvg/index.mjs`, `resvg/index_bg.wasm` | resvg (SVG to PNG) compiled to WebAssembly, 2.6.2 | npm `@resvg/resvg-wasm` (github.com/yisibl/resvg-js) | MPL-2.0 |
| `fonts/RobotoCondensed-400.ttf`, `-500.ttf`, `-700.ttf` | Roboto Condensed, Latin subset | Google Fonts | SIL Open Font License 1.1 |

Used by `worker/src/card-render.js` to draw the Discord cards for live plays.
