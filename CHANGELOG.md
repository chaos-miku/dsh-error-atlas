# Changelog

All notable changes to **dsh-error-atlas**. Versions follow `0.11.x` while the plugin
is in the DSH marketplace pipeline; the panel's `V##` chip is the **client bundle** build
stamp, which only moves when `client.js` changes — a `V51 · 0.11.24` panel is expected.

## 0.11.25

- Client tests no longer depend on the checkout's line endings: the test seam matches the
  slot list with `\r?\n`, and `.gitattributes` normalises the repository to LF. First green
  Windows CI run (it was failing on a CRLF checkout).

## 0.11.24

- **CI**: GitHub Actions runs the full suite on Ubuntu and Windows, Node 20 and 22
  (`.github/workflows/ci.yml`), plus a manifest installability check.
- `react` / `react-dom` are dev-dependencies now, so the client tests render outside DSH
  (the panel still borrows the Harness copy at runtime).
- First `CHANGELOG.md`.

## 0.11.23

- Ambient signatures no longer mark lessons as failed: a signature referenced by ≥4
  retrospectives is the environment (a shell quirk), not the mistake any single lesson
  was about. Bare exit codes never count as recurrence evidence either.
- Live effect on a real store: 26 "failed lessons" → 5.

## 0.11.22

- Command fingerprints: an exit is recorded as `exit code N · <exe + script> · <stderr line>`
  instead of the whole command line, so the same script failing in different directories is
  one signature.
- Noise muting: bare exits (≥5 occurrences, no stderr) leave the graph and are counted in
  `stats.noise`; `showNoise` brings them back.
- `essence` on every retrospective — one ≤96-char line (`if <this> → <cause> → <next time>`)
  that is what the model actually gets injected; derived automatically when the writer
  omits it.
- Prompt briefing now sends at most three essence lines, skips auto skeletons, and only
  promotes a failed lesson when it really pointed at an error.
- Store v3 one-time migration: fingerprints recomputed, duplicate signatures merged, lesson
  links remapped to the new ids, `essence` backfilled — one write.

## 0.11.21

- Recurrence is judged against the records the graph actually shows: muting a signature no
  longer makes its lessons look more broken.

## 0.11.20 (V51)

- Failed-lesson wires get their own colour chip (`#ff5b4d`); before this the red chip
  controlled core spokes, which were nearly invisible.
- Core spokes `0.07 → 0.16`, hub spokes `0.2 → 0.26`, chips 10px with dashed off-state,
  per-row "lit/total" count (`4/5`) and `✓/✕` titles.

## 0.11.19 (V50)

- Colour chips made legible: bigger targets, visible off-state, counts.

## 0.11.17 (V48)

- Node-kind and wire-role colour filters, left of Refresh, persisted in `localStorage`.

## 0.11.16 (V47)

- Spacing dial: scales node positions only — not the camera, not the diameters.

## 0.11.15 (V46)

- Appearance popover: spin, size, pulse size, glow — and pulses now ride the wire itself.
- Bulb-style double-layer glow (`HALO_FS` `pow(1-r, 2.1)` + white-tinted core).

## 0.11.14 (V45)

- Dedicated halo pass with its own glow dial (0–400%).

## 0.11.13 (V44)

- Node size decoupled from the camera: `uRefDist` keeps the dial's meaning stable.

## 0.11.12 (V43)

- The learning pulses follow the size dial.

## 0.11.11 (V42)

- The size dial really reaches 10%; point size is capped at 44px so zoom-in cannot turn
  nodes into plates.

## 0.11.10 (V41)

- Nodes are points again: the solid core fills ~57% of the sprite and base sizes halve.

## 0.11.9 (V40)

- Size dial for the whole map; solid anti-aliased node cores.

## 0.11.8 (V39)

- Zoom goes further and faster: wheel 1.75×, floor 12 world units.

## 0.11.7 (V38)

- Program satellites park on the side of their own failures and sit closer in.

## 0.11.6 (V37)

- Clicking a node closes the camera in on it; smaller halos.

## 0.11.5 (V36)

- Orbit-any-node camera: the chosen node becomes the centre of rotation.
- Calmer sprite brightness (additive blending was over-exposing the islands).

## 0.11.3 / 0.11.4 (V34 / V35)

- Program satellites orbit outside the cloud.
- **Session islands**: each session window is its own ball with its own failures; DSH sits
  at the centre; programs orbit outside. `maxNodes` 240 → **2400**, with grid repulsion,
  dynamic cloud radius, adaptive warm-up and island anchors.
- Bench (fake GL): 240 / 900 / 2400 nodes → 0.9 / 5.7 / 14.5 ms per frame.

## 0.11.2

- `atlas-digest` exits 0 on a fresh install with an empty summary instead of failing.
- README gains the npm install path (`plugin_manager install_bundle target="dsh-error-atlas"`).

## 0.11.1

- README screenshot points at the raw GitHub URL so npm renders it.

## 0.11.0

- First release: runtime error capture (`agent/error`, `api-session/error`,
  `agent-loop/config-start-failed`, tool failures), signature dedupe, `atlas_retro` tool,
  automatic skeleton retrospectives, global prompt section, `atlas_lessons` read tool,
  lesson links, recurrence flags, program hubs, projection/search/trends, Markdown export,
  lesson-effectiveness board, two memory switches, GPU knowledge graph panel.

[0.11.24]: https://github.com/chaos-miku/dsh-error-atlas/compare/8f92a73...HEAD
