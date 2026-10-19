# vibes — plan

A web UI for [arclamp](https://github.com/JCLemme/rclamp), the programmable
lighting system at the Recurse Center, served at `vibes.recurse.com`.

## Decisions

- **Architecture: vibes has its own server.** Recursers log in to vibes with RC
  OAuth. The vibes server holds one arclamp key and forwards every request.
  The browser never sees the arclamp key and never talks to arclamp directly.
- **Configuration is env vars**, so arclamp and vibes can live anywhere: both on
  one Pi, or on two different hosts.
- **No admins.** Everyone can edit everything, matching RC culture and arclamp.
  "Edit lights" sits behind an "admin mode" switch in the user menu, which
  anyone can turn on; it is a guard against slips, not a permission. Room tone is open to everyone: it's the control people will
  want most.
- **Degraded states are banners** across the top of the whole site: arclamp
  unreachable or refusing vibes' key, a radio disconnected, a dry run, or no
  live data. Nothing shows while all is well.
- **The map is the interface.** The room is drawn from above, each light a
  glow in the color it's making, and the map is always the whole window, at
  every size; everything else floats over it, as on Google Maps. Along the
  top: banners about degraded states, then a chip for each tag (left) and the
  account (right). Floors and zoom sit bottom right. Room tone,
  shaders and history are coming back one at a time, as overlays.
- **You only change the floor you're on.** Only lights on the floor being
  shown can be selected, and so changed; switching floors lets go of the
  selection. Each tag on this floor is a chip that turns on and off on its
  own, adding its lights here to the selection or taking them out; a count
  ahead of them clears it all.
- **No key minting in the UI yet.** vibes' own key carries `mint` so it can be
  turned on later without re-keying.
- **TypeScript throughout.** Vite + React frontend, Hono server on Node 24,
  SQLite via the built-in `node:sqlite`.

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `ARCLAMP_BASE_URL` | yes | e.g. `http://127.0.0.1:8080` |
| `ARCLAMP_KEY` | yes | arclamp service token for vibes |
| `SESSION_SECRET` | yes | ≥ 32 chars; signs login cookies |
| `PUBLIC_URL` | prod | where people reach vibes, comma-separated, main one first, e.g. `https://vibes.hall.ly,https://vibes.recurse.com` |
| `RC_CLIENT_ID`, `RC_CLIENT_SECRET` | prod | RC OAuth app; callback is `<main address>/auth/callback` |
| `VIBES_DEV_LOGIN` | no | `1` allows logging in as any name; refused when `NODE_ENV=production` |
| `DATABASE_PATH` | no | SQLite file, default `vibes.db` |
| `PORT` | no | default `8787` |

Mint the production key on the arclamp host, with full access (no `-perms`):

```sh
sudo /opt/arclamp/bin/arclamp token mint -tokens /opt/arclamp/etc/service_tokens.json \
  -token-key /opt/arclamp/etc/token.key vibes
sudo systemctl reload arclamp   # SIGHUP rereads the tokens
```

Mint it there, not through the API with someone's own key: keys form a tree,
and revoking a key revokes every key minted with it.

## How vibes relates to arclamp

- **Light stream.** vibes keeps one connection to arclamp's live stream and
  relays it to every browser at up to 30 frames a second, unchanged (packed
  binary; decoded in the browser using the channel order from `/v1/lights`).
- **Scene changes.** arclamp has no change notifications, so browsers poll the
  scene through vibes about once a second.
- **Authorship.** arclamp records every vibes action as `vibes`, so vibes keeps
  its own log of who did what. vibes doesn't create or edit shaders itself;
  each shows as "Shader #id".
- **Shader contract** (from `internal/sandbox/runtime.go`):
  `update(prev, nowMs, initialMs)` is called at 100 Hz with
  `{initial_time, lights: [{id, channels, tags, coords, rail}]}` and must
  return `{lights: [{id, channels}]}`. Channel values are float32 and pass
  through as given, out of range included; anything that isn't a finite
  number is dropped (the channel keeps the value from below) with a warning in
  arclamp's log. Omitted lights and channels keep the value from below
  (rclamp PR #5).

## Color: lemtone

Lights speak Lemtone (Walter's rc-bulb-firmware `lemtone/` is canonical),
as arclamp channels (rclamp PR #5):

- `a`, `b`: the color, as OKLab a and b at L = 1.
- `brightness`: luminous flux, 1.0 = 1000 lm (a fixed unit, not any light's
  maximum).
- `fidelity`: 0 builds pale colors and whites from the RGB LEDs, 1 from the
  white ones.

Color bulbs and 4×1 panels take all four and solve them into PWM on the bulb
(sent as `0x07`). Old bulbs can't dim, so they have their own channel, `on`
(1 on, 0 off; on at 0.5 or more), and vibes shows them as a 2700 K
incandescent when on. Room tone gives color lights the picker and old bulbs an
On/Off switch, side by side when a selection has both.
vibes doesn't solve anything: `src/shared/lemtone.ts` is the color math for
picking and display (Walter's Planckian spline for whites, OKLab to sRGB for
swatches), and `src/shared/fixtures.ts` maps channels to and from lemtones.

The picker offers whites by color temperature, or colors from a disc in OKLCh
at L = 1 (hue around, chroma out from white), plus brightness in lumens on a
cube-root track (how bright it looks) and fidelity. Brightness is absolute, so
saturated colors are dim: a bulb's pure blue tops out near 28 lm, red 48,
green 120, and asked for more it keeps the brightness and fades the color
toward white. The map and picker show the color asked for; what each bulb
actually makes will come from arclamp once it runs Walter's solver itself.

## Map and floors

The floor plans of 397 Bridge Street (floors 4 and 5, `src/web/floors/`)
share one frame in real-world millimeters, with the origin at the building's
top-left wall corner. They're drawn as faint lines under the lights, over a
grid whose spacing follows the zoom, with a metric and imperial scale bar.

Dragging across the map box-selects lights (shift adds to the selection,
⌘-click toggles one). ⌘-drag, middle-drag or one finger pans; scroll or pinch
zooms around the pointer (or the buttons, with "fit" to see the whole
building). Switching floors keeps the view, so the building never jumps.

A light's position is arclamp's `coords`: `{ "mm_x", "mm_y", "floor" }`, or
absent until placed (rclamp PR #2). 4×1 panels are drawn at their real
1 ft × 4 ft size: type `4x1` stands vertically on the plan, `4x1-horizontal`
lies on its side. Turning a panel switches its type; both types share the
same channels and color handling (`baseType` in `src/shared/fixtures.ts`).

Lights without coords wait in a drawer: a small card in the map's
bottom-left corner opens a sheet, as wide as the space between the panels,
that grows up from the bottom edge (the card, floors, scale and zoom ride up
with it). It starts
closed when there are many, and disappears when there are none (the normal
case in production).

**Editing lights.** "Edit lights" (in admin mode) turns dragging a light into moving it (a
selected light drags the whole selection); dragging into the drawer takes it
off the plan, dragging out of the drawer places it, and R or "Turn" switches
selected panels between vertical and horizontal. Positions and turns are
saved in vibes' database (`placements`, `light_types`) and shown to everyone
straight away; arclamp learns them when someone exports `lights.json` (it
adds the `4x1-horizontal` light type when needed), commits it to rclamp's
`deploy/lights.json`, and deploys. With nothing changed, the export is
byte-identical to that file.

**Tags.** In Edit lights, the selected lights' tags show in a card under the
toolbar: a tag only some of them carry is dashed, with how many (clicking it
puts it on the rest), × takes a tag off them all, and the box adds one to
them all. Tags are arclamp's (`tags` in `lights.json`, which shaders see on
every light), kept easy to match in code: lowercase letters, digits, - and
_, typed words joined with hyphens (`src/shared/tags.ts`). vibes keeps each
tagged light's whole set in `light_tags` until exported, like positions.

**Rails.** Bulbs hang on rails: straight tracks on one floor, kept in
arclamp's `lights.json` (`rails`, and a light's `rail: { id, mm_along }`,
rclamp PR #3). A railed light still has `coords`, derived from its rail, so
shaders can use rails or ignore them. 4×1 panels sit in the ceiling grid and
never hang on rails. While moving lights, "Draw rail" draws rails by dragging
along each track (ends settle exactly level or plumb within a couple of
degrees, shift steps by 45°, and ends catch on other rails' ends). Click a
rail to select it; dragging it moves it with its lights, and dragging an end
pivots it around the other end, with lights keeping their distance from the
end that stayed put. A dragged light that comes near a rail hangs on it and
slides along it until it's pulled well away. Deleting a rail leaves its
lights where they are, as free lights. vibes keeps its rail changes in the
`rails` table and lights' rail spots in `placements` (`rail_id`,
`mm_along`), and the export writes both.

## Milestones

1. **Foundation.** ✅ Local arclamp harness, env config, typed arclamp client,
   dev login, live stream relay, scene list, room grid, health.
2. **Shader stack.** Retired: vibes no longer creates, edits or deletes
   shaders itself. The selection panel keeps each shader's mute, mask and
   place in the stack.
3. **Room tone.** ✅ Left panel: the whole room, a type, or lights selected on
   the map (click, shift-click, drag a box), set with the lemtone picker.
   Old bulbs get on/off.
4. **Simulated mode.** ✅ Any edit (room tone, or a shader's mute, mask or
   place in the stack) is pending, kept per browser, until
   Apply sends it all to arclamp or Discard drops it. Meanwhile the map shows
   a preview: room tone plus each shader running in its own Web Worker, merged
   as arclamp merges, about 30 times a second. The UI says so: an Apply bar
   over the top of the map, a cooler palette, and a glow round the window. Differences from the
   real sandbox: no `udp`, browser CORS applies to `fetch`, different JS
   engine.
5. **Floor plans.** ✅ Floors 4 and 5 under the lights, a floor switch, a
   pannable and zoomable map with a scale bar and grid, panels at real size,
   moving and turning lights with undo, rails to hang lights on, and a
   `lights.json` export.
6. **RC OAuth and deploy.** vibes runs on kokuzo's k3s at `vibes.hall.ly`,
   and at `vibes.recurse.com`, RC's proxy in front of it. RC's OAuth app takes
   one callback, on `vibes.hall.ly`, so a login from `vibes.recurse.com` hops
   there and comes back with a one-time code. Each push to `main` runs `.github/workflows/deploy.yaml`: typecheck and
   tests, then the flake's image (`kokuzo.tailc38f.ts.net/vibes:<sha>`) is
   pushed and `.kube/version.yaml` pinned to it on the `cd` branch, which
   Argo CD (`deploy/argocd-application.yaml`) syncs. Secrets live in the
   `vibes-secrets` Secret; kokuzo's Cloudflare tunnel (nixos-config) routes
   the hostname to the Service's NodePort, 30787. `deploy/local` is the same
   on a local cluster.

Later: key minting (keys handed out must not include `mint`, since any `mint`
key can revoke every token, including vibes').

## Gaps in arclamp (PRs to rclamp)

1. **Shader logs.** `console.log` from a running shader only reaches arclamp's
   server log (`internal/scene/worker.go:493`); `/v1/scene/log` from the design
   doc was never built. The editor needs this.
2. **Change notifications**, so vibes can stop polling the scene.
3. **Non-cascading revoke**, so rotating vibes' key doesn't revoke every key it
   minted.
4. **Errors are never cleared.** A shader's `error` stays set after a later
   script runs fine (`setErr` is only ever called with a message), contrary to
   the API reference's "only in error state".
5. **Silent rollback.** arclamp only compile-checks a script before accepting
   it; one that then fails as it starts is quietly swapped back to the
   previous script (or, for a new shader, crash-loops), without any signal in
   the API response.
6. **`update()` returning `null` kills the sandbox without an error.** The
   shader crash-loops until arclamp gives up after 8 tries; nothing explains
   why.

## Local development

```sh
pnpm install
pnpm arclamp:build   # compile arclamp + sandbox from ~/Documents/JCLemme/rclamp (ARCLAMP_SRC)
pnpm arclamp:setup   # local state, a vibes token, and .env
pnpm arclamp         # local arclamp, simulation only
pnpm dev             # vibes server + Vite, http://localhost:5173
```

`pnpm arclamp:radio` drives a base station plugged into the Mac, on
production's channel; every bulb in range follows it.

## To confirm

- RC OAuth endpoints: `https://www.recurse.com/oauth/authorize`,
  `/oauth/token`, and `/api/v1/profiles/me` for the profile.
