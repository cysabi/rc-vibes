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
| `SKETCHES` | no | `1` turns sketches on (see Sketches) |
| `SKETCHES_DIR` | no | sketches' repos, default `<DATABASE_PATH's folder>/sketches` |
| `BOX_IMAGE` | sketches | the box image |
| `BOX_RUNNER` | no | `docker` (default: containers on this machine) or `kubernetes` (pods on the cluster vibes runs in) |
| `BOX_VIBES_URL` | kubernetes | where boxes reach vibes; with Docker, `http://host.docker.internal:$PORT` |
| `BOX_NAMESPACE`, `BOX_RUNTIME_CLASS` | no | where box pods run (default `vibes-boxes`), and with what (default `kata`; empty for the cluster's own) |
| `BOX_IDLE_MINUTES` | no | a box whose page hasn't checked in for this long is removed (default 15); its home is kept |
| `BOX_POOL` | no | how many booted boxes wait to be claimed (default 2) |
| `BOX_HOMES` | no | where everyone's homes are kept: a Docker volume (default `vibes-box-homes`), or a directory on the cluster's machine (default `/var/lib/vibes/box-homes`) |

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
  relays every frame to every browser as it arrives (100 a second while the
  lights change), unchanged (packed binary; decoded in the browser using the
  channel order from `/v1/lights`). A frame that only repeats the last one is
  skipped, with one sent at least every second regardless. Networks deliver
  frames in clumps, so the browser doesn't show them as they come: it plays
  each at its own beat (`initial_time`) plus a delay, which follows how late
  frames have been arriving (just above nearly all of them, 40–400 ms, changed
  gradually). Frames are never blended, so a strobe stays a strobe. Admin
  mode shows the delay, and how many frames came too late, beside the scale.
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
   tests, then the flake's images (`kokuzo.tailc38f.ts.net/vibes:<sha>`, and
   sketches' boxes' `vibes-box:<sha>`) are pushed and `.kube/version.yaml`
   pinned to them on the `cd` branch, which
   Argo CD (`deploy/argocd-application.yaml`) syncs. Secrets live in the
   `vibes-secrets` Secret; kokuzo's Cloudflare tunnel (nixos-config) routes
   the hostname to the Service's NodePort, 30787. `deploy/local` is the same
   on a local cluster.
7. **Sketches.** ✅ Their pages, each person's own VS Code for a sketch (a
   box) with the preview and console as its panels, and git to share them
   (see Sketches). Nothing goes to the room yet.

Later: key minting (keys handed out must not include `mint`, since any `mint`
key can revoke every token, including vibes').

## Sketches

Code made in vibes is a **sketch**; rclamp's word stays "shader". A sketch is
a git repo whose `main` is the sketch, and what runs in the room will only
ever be built from one of its commits. On while `SKETCHES=1`.

- **Pages, not over the map.** `/sketches` lists them (and makes them: a first
  commit with a gentle wave in `main.ts`, its types in `vibes.ts`, and a
  README); `/sketches/<uuid>` is one, in your own VS Code under vibes' bar.
- **No tie to the room yet.** No copies in the room, no versions, nothing to
  put in the room. Those come later.
- **Your own VS Code: a box.** Opening a sketch starts your box for it
  (`src/server/boxes.ts`): openvscode-server with your own clone of the
  sketch, on your own branch, and vibes' extension, from the box image
  (`flake.nix`, started by `box/start.sh`). On kokuzo it's a pod in
  `vibes-boxes`, in a Kata VM, reached only by vibes and reaching only DNS,
  vibes and the public internet (`.kube/boxes.yaml`); locally, a Docker
  container. The terminal is hidden, but the sandbox is the boundary: tasks
  and extensions can run anything.
- **Near-instant, from a warm pool.** vibes keeps `BOX_POOL` boxes booted and
  no one's yet, each running only its agent (`box/agent.ts`); a Kata pod
  takes ~10 s to boot, so none is booted while you wait unless the pool's
  run dry. Opening a sketch claims one: the agent, root in its VM, bind-mounts
  your home from the homes every box is given (`/homes`, which on kokuzo is
  `/var/lib/vibes/box-homes` on tank) at `/home/workspace`, unmounts the
  rest, and starts VS Code as uid 1000 with no capabilities; vibes records
  whose it is (`boxes.pod`), and boots another for the pool. A box is never
  anyone else's after, and is removed when done with; homes are kept. The
  trade-off: every box's VM has every home shared into it, so code that
  escaped to root in its VM could reach other homes (not just its own).
- **Lifetime: while your page is in sight.** The sketch page checks in every
  30 s while it's visible (and at once when it becomes visible again); a box
  nothing's checked in on for `BOX_IDLE_MINUTES` is removed. A page that
  finds its box gone, or on a new run, covers VS Code ("Waking your VS
  Code…") and loads it afresh once it's ready: the files are in your home
  and the open tabs in the browser, so only undo history is lost. vibes
  restarting adopts boxes from the same image; after a deploy (a new box
  image) it removes them all, so no page talks to an older extension, and
  open pages wake theirs again on the new image.
- **Deleting.** Anyone can delete a sketch (from its page), and anyone can
  restore it, always (from its page, or the library's "Recently deleted"
  dropdown; `/sketches?deleted=<id>` opens that with it picked out).
  Deleting removes everyone's boxes for it, and nothing opens it meanwhile;
  its repo and everyone's homes are kept.
- **Stamps: knowing its own shaders** (`src/server/stamp.ts`). Every script
  vibes builds for the room will start with a line naming its sketch and
  commit, signed (HMAC-SHA256, over that and all the code under it) with
  `VIBES_SIGNING_KEY`, which boxes and builds never see. vibes checks each
  shader's script as it passes the scene on: a plain shader, sketch X at
  commit Y, or edited (changed since, or signed with another key). "Lit by"
  shows the sketch's name and short commit, badged "edited" or "deleted",
  with a button that opens the sketch at that commit (a checkout of just it,
  `/home/workspace/commits/<commit>/sketch` beside your clone, made by the
  extension; `/sketches/<id>?commit=<sha>`), or, deleted, finds it in the
  library's "Recently deleted". The builder (below) makes stamped scripts;
  nothing puts them in the room yet.
- **Through vibes only.** `/box/<id>/…` is proxied to your box's VS Code, for
  you only (`src/server/box-proxy.ts`). The box never sees vibes' cookies,
  only its VS Code's connection token, which vibes adds (and sets for the
  box's own path, for VS Code's page); nothing the box sets as a cookie
  reaches the browser.
- **Sync is git.** The sketch's canonical repo is on vibes' volume
  (`/data/sketches/<uuid>.git`), served over HTTP at `/git/<uuid>.git` to its
  boxes, each with its own token (`src/server/git.ts`). Plain VS Code source
  control brings changes together; anyone can change `main`. What saving
  commits comes later.
- **The preview runs in the browser, on its own** (`src/web/preview`), in a
  "Sketch" panel in VS Code beside the console (`box/extension`). The sketch
  runs in its own worker, on its own clock, drawn on its own map from the
  lights' layout (which the extension gets from vibes with the box's token);
  it never touches the room. Play, pause (which stops calling `update()`) and
  restart in the panel's title bar, the clock in the status bar; lights
  select as on the map, with what they look like in the corner. Build errors
  go to Problems, and the preview keeps running what last worked.
- **Two loops: the room's build, and the editor's.** How a sketch is built is
  decided the same way for both (`src/shared/sketch-plan.ts`): `sketch.json`'s
  commands, if it has one (`build` and `dev`, each `{ command, output }`, dev
  with `watch` if it watches by itself); otherwise a `package.json` `build`
  script, writing `dist/sketch.js`; otherwise its entry (`main.ts`, …) built
  by Vite (with its own `vite.config`, if any). Packages install first (pnpm
  or npm, by lockfile). The room's build is allowed to be slow and exact; the
  editor's is fast, with the toolchain's own tools (a Nix sketch's dev shell,
  its language's watcher), never `nix build` on save.
- **HMR, in tiers** (`box/extension/src/dev.ts`, the preview's worker). A Vite
  sketch runs as its modules, from a Vite dev server in the box, through
  Vite's module runner in the preview's worker, their messages relayed through
  the webview: an edit runs only what changed again (the entry accepts its
  updates, and hands the worker its new `update()`), and the rest keeps its
  state (`import.meta.hot.data` keeps the edited module's). Any other sketch
  swaps in each new script its dev command (or build) writes, on the same
  clock, its own state starting over. Toolchains that can patch running code
  (Rust's `subsecond`) would be a third tier, an adapter each, later. A
  preview stopped by an error starts again on the next update.
- **The builder** (phase 6; `src/server/builds.ts`, `box/builder.ts`). A build
  of a commit runs in a pod of its own, from the box image (`builder.mjs`
  beside the extension): Kata, uid 1000, no privileges, the boxes' network
  rules, 15 minutes at most. It fetches the commit from vibes (a tar, at
  `/build-api/source`, with its own token), installs, builds as planned, and
  sends back the script and its log (`/build-api/result`, once). vibes checks
  the script itself (a script rclamp can run, at most 256 KB, defining a
  global `update()`), stamps it, and keeps it with the log. A commit's built
  once per builder version. `POST /api/sketches/<id>/builds` (`{ commit }`,
  main's by default), `GET …/builds`, `…/builds/<id>` (with its log),
  `…/builds/<id>/script`. Nothing uses builds yet: putting one in the room is
  phase 7.

Still to come: VS Code's own defaults that only its product configuration
sets (no AI chat; the welcome page is skipped from VS Code's address), its
webviews served from our own domain rather than Microsoft's CDN, boxes on
their own origin (now their page shares vibes'), faster boots for refilling
the pool if it runs dry often (Kata VM templating, an initrd), what saving
commits, and the room: the trusted builder, the stamp (an
HMAC over the built script, so an edited copy shows as edited), and putting
sketches in the room.

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

Sketches locally: build the box image for this Mac's Docker (through a Linux
builder, e.g. OrbStack's) and run with `SKETCHES=1 BOX_IMAGE=vibes-box:dev`.

```sh
nix build .#boxImageLocal && docker load < result   # then: docker tag <loaded image> vibes-box:dev
pnpm build:box   # just the extension and its preview, into box/dist
```

## To confirm

- RC OAuth endpoints: `https://www.recurse.com/oauth/authorize`,
  `/oauth/token`, and `/api/v1/profiles/me` for the profile.
