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
  anyone can turn on; it is a guard against slips, not a permission. The
  room's color is open to everyone: it's the control people will want most.
  It's Base Tone (below), vibes' own shader at the bottom; arclamp's room
  tone, under it, is shown and changed in admin mode only.
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
| `VIBES_DEVICE_KEYS` | no | `name=key,…`: devices that log in with a key (≥ 32 chars) instead of RC, by opening `/auth/device?key=<key>` once; they're `device:<name>`, can do what anyone can, and are logged out when their key changes or goes |
| `VIBES_DEV_LOGIN` | no | `1` allows logging in as any name; refused when `NODE_ENV=production` |
| `DATABASE_PATH` | no | SQLite file, default `vibes.db` |
| `PORT` | no | default `8787` |
| `SKETCHES` | no | `1` turns sketches on (see Sketches) |
| `SKETCHES_DIR` | no | sketches' repos, default `<DATABASE_PATH's folder>/sketches` |
| `BOX_IMAGE` | sketches | the box image |
| `BOX_RUNNER` | no | `docker` (default: containers on this machine) or `kubernetes` (pods on the cluster vibes runs in) |
| `BOX_VIBES_URL` | kubernetes | where boxes reach vibes; with Docker, `http://host.docker.internal:$PORT` |
| `VIBES_SHADER_URL` | no | where shaders in the room reach vibes, for their params; default the main `PUBLIC_URL` in production, `http://127.0.0.1:$PORT` in development when arclamp's on this machine too, and otherwise none (no shader is linked) |
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
  return `{lights: [{id, channels}]}`. `initialMs` (and `initial_time`) is the
  frame's time, not the shader's start: the room tone stamps each tick with
  the wall clock, and every layer of that frame gets the same value, so the
  layers stay in step. `nowMs - initialMs` is only the delay through the
  stack (about 60 ms, measured), so time since a sketch started is the
  sketch's own to keep, from the first `initialMs` it sees. The editor's
  preview passes time the same way. Channel values are float32 and pass
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
or, all of them selected already, takes them out; alt takes them out, or,
none of them selected, adds them; ⌘-click toggles one); so does one finger, adding, with no hold first, and
holding a finger on a light shows what it is. ⌘-drag, middle-drag or two
fingers pan; scroll or pinch zooms around the pointer (or the buttons, with
"fit" to see the whole building). Switching floors keeps the view, so the building never jumps.

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
   Old bulbs get on/off. Now Tone's, over the room tone (below).
   - **Tone, the base Tone, and the room tone** (`src/shared/base-color.ts`).
     arclamp's room tone is the room's "normal", and only admin mode shows it
     (and its color editor). Tone is a sketch baked into vibes
     (`src/default-sketches/tone.ts`, built beside the web app): a Color param for each
     color light and a switch for the old bulbs (2800K at 703 lm, old bulbs
     off, by default). It's in the library like any sketch, and any number
     can be added, cloned and taken out, but its code is vibes' own: there's
     none to open, fork, update or delete, and its build is vibes' (asked to
     build it, the sketches API answers with it).
     One Tone is the room's base, shown as "Base Tone": vibes puts it in at
     the bottom, on every light, at its defaults (nothing's copied in from
     the room tone, so it has no hidden state), holds it muted until its
     params link, moves it back down when anything goes under it, and when
     it's gone puts it back as it was (its shader lost) or anew (taken out).
     Its home can't be moved; the layers panel won't drag or delete it
     (the server would let it be taken out); muting and masks work as for
     any shader, and its params are open under its row in the selection to
     start with.
   - **Default sketches** (`src/shared/default-sketches.ts`). vibes' own
     sketches, in a section of their own at the top of the library: Tone,
     and Transition (each color light from the light below it to an End tone,
     with Easing, Speed in transitions a second, and Reverse: back and forth,
     or over again from the start), and Rainbow (every hue in turn, a wave
     across the room, with Speed in times round a minute, Brightness in
     lumens, and Saturation against what the bulbs make of each hue). Each is built with vibes
     (`src/default-sketches/<entry>.ts`, to `dist/default-sketches/`) and
     made as vibes starts (`server/default-sketches.ts`), one build each; the
     sketches API answers a build of one with it, and there's no code of one
     to open, fork, publish, update or delete.
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
   there and comes back with a one-time code. A page at `vibes.recurse.com`
   reaches the API and its sockets at `vibes.hall.ly`, with no proxy between
   (`/auth/options?origin=` says where): with a 10-minute token from its own
   address (`/auth/token`, its session signed), as `Authorization: Bearer`
   and as each socket's first message, since its cookie doesn't go from one
   site to the other; vibes lets the other address's pages (CORS). A page
   that can't reach `vibes.hall.ly` (a request to it fails outright, as one a
   proxy or CORS turns away does) uses its own address for all of it. Logging
   in and out stay at the page's own. Each push to `main` runs `.github/workflows/deploy.yaml`: typecheck and
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
  sketch, on main, and vibes' extension, from the box image
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
  escaped to root in its VM could reach other homes (not just its own). In
  a home, the clone is at `/home/workspace/sketches/<sketch id>/sketch`: a
  path of its own for each sketch, since VS Code keeps a folder's open tabs
  in the browser by its path.
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
  control brings changes together: your own clone keeps what you've staged
  and committed until you sync, which pulls main (your commits rebased on
  top of everyone else's) and pushes it. Anyone can change `main`. (Clones
  once started on a branch of each person's own, which the room never
  builds; `box/start.sh` moves one that can to main.) What saving commits
  comes later.
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
  with `watch` if it watches by itself); otherwise, with a `flake.nix`,
  `nix build .#sketch` (its output the script, or a folder with `sketch.js`);
  otherwise a `package.json` `build` script, writing `dist/sketch.js`;
  otherwise its entry (`main.ts`, …) built by Vite (with its own
  `vite.config`, if any). Packages install first (pnpm or npm, by lockfile).
  The room's build is allowed to be slow and exact; the editor's is fast,
  with the toolchain's own tools (its language's watcher, in the flake's dev
  shell), not `nix build` on save unless that's all it has.
- **Nix, first-class.** Every box and build has Nix (flakes on). A flake
  sketch brings its own tools: its own commands (`sketch.json`'s, installing
  its packages) run in its dev shell (`nix develop`). Nix's daemon runs as
  root in the VM (started by the box's agent, after the homes are gone,
  unable to mount anything; and by the builder before it drops to uid 1000),
  building as Nix's build users, with Nix's own sandbox off: the VM is the
  sandbox. The store is the VM's own, fresh each box and build, so a toolchain
  downloads from cache.nixos.org the first time in each (a cache on kokuzo,
  or each person's store kept in their home, can make that fast later). Nix
  sees what git does: a new file needs `git add` before a Nix build sees it.
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
  `…/builds/<id>/script`.
- **Builds in the room** (phase 7; `src/server/instances.ts`). An instance
  (below) is the only way vibes makes a shader or changes one's script, and
  it takes a build, never a script: what goes in is the build's own stamped
  script, and only if it built, its sketch isn't deleted, and its stamp
  checks out with vibes' key.
- **Instances: a sketch is a class, a shader in the room an instance**
  (`src/server/instances.ts`). An instance is put in from a selection on the
  map, which is its *home*: `POST /api/instances { sketch, commit?, home }`.
  It's in vibes from that moment, building its commit (or using the build
  there is); once built it's a shader in arclamp, on top, masked off every
  light outside its home, so its home is all it can light (its code still
  picks which of those it does; made from the whole floor, the code decides).
  Its home is vibes' own, kept apart from arclamp's mask, so switching lights
  on and off never moves it (`PUT …/home` does). `POST …/update` builds main's
  latest (or a commit) and swaps it in once built, the old one running
  meanwhile; `DELETE /api/shaders/<key>` (its key is its id) takes it out,
  as does its shader going any other way.
- **Adding it with your changes** (`src/server/changes.ts`,
  `box/publish.sh`). What goes in is built from main, so adding a sketch on
  the map first asks vibes whether your editor has changes main hasn't (files
  not committed, commits not pushed): `GET /api/sketches/<id>/changes`. vibes
  reads your home itself, mounted read-only (`BOX_HOMES_MOUNT`; the homes'
  folder is 711, so it reaches one by name but nothing lists them), without
  waking a box. It never runs git there, since a clone's config names
  commands git would run: isomorphic-git, which runs nothing, reads it, in a
  worker of its own, through a view that never follows a symlink or leaves
  the clone. If there are changes, it asks whether to include them. Yes
  (`POST …/publish`) claims a box from the pool for only that: as you, in
  your home, everything not ignored is committed, rebased onto main's latest
  and pushed, and the box is removed; then the sketch is added. Changes that
  clash with main push nothing, and say so.
- **What a selection lists** (`SelectionPanel.tsx`): every shader whose home
  takes in any of its lights, or, for one with no home (made outside vibes, or
  before instances), whose *footprint* does: every light its code has changed,
  before its mask or mute, since its script last changed (learned from
  arclamp's `changing`, kept in vibes' database). Plus shaders on their way
  in, homed on any of them. Rows are in stack order and never move. A shader
  is **on**, **on for some** or **off** (muted and masked off everything are
  one off); its switch is for these lights. Its own panel says what's become of it (building, couldn't go
  in, failing, updating), its home (moved to the selection with a button),
  and offers its code, an update to its sketch's latest commit, and taking it
  out.
- **The live state** (`src/shared/live.ts`, `src/server/live.ts`,
  `src/web/scene.ts`). Everything a page shows or changes of the room is one
  tree, each value at a path: room tone (`roomtone/<light>/<channel>`), the
  shaders as vibes has them (below) and their order (`stack`), the params'
  pools (`pools/<pool>`, below) and the map's layout (`layout`). vibes
  holds it; each page keeps a copy, over the room socket (`/api/scene/ws`):
  the whole tree once it says hello, then each change as it's made, small
  (a room tone step is ~130 bytes, where the whole scene was 10.5 KiB), and
  numbered, so a page that reconnects says the last it had (and which run
  of vibes it was from) and gets just what it missed. The scene's part is
  made from arclamp's (followed as it changes, footprints learned from the
  light stream: `src/server/scene-feed.ts`), each shader with its sketch,
  footprint, instance and pool, but not its script (a hash says which; the
  preview fetches scripts it hasn't got, `/api/scene/scripts`). A ping every
  10 s lets a page tell a quiet socket from a dead one and open it again (a
  restarting vibes, behind a proxy that keeps the connection, never says).
- **Updates** (`src/server/updates.ts`). A page changes the tree only by
  sending an update: some paths and their new values (or a path taken away),
  checked all at once and refused whole if any isn't one a page can change.
  vibes makes them one page's at a time, area by area, in the order that
  keeps the room right (room tone; shaders out; sketches in, their pools
  first; each shader's home, mute and mask, the mask before it's unmuted;
  params; the stack; the layout), those that come while one's being made
  together, the latest of each path winning; and answers each once the tree
  shows it. Room tone, each shader and the stack are each changed in arclamp
  one call at a time, whatever comes meanwhile merged into the next, so the
  room keeps up with anyone's drag without a queue. Pending edits stay in the
  page (its draft) until vibes says they're made: Apply sends them as one
  update; live mode sends them as they change, without waiting for the last
  to land, so the room keeps up at the cost of one trip there, not a round
  trip a step. Room tone is held by arclamp, a pool's values are saved a
  second after they last changed, and the history notes a run of changes as
  one entry. The map's own edits (lights moved, turned, tagged; rails) are
  updates too.

Still to come: VS Code's own defaults that only its product configuration
sets (no AI chat; the welcome page is skipped from VS Code's address), its
webviews served from our own domain rather than Microsoft's CDN, boxes on
their own origin (now their page shares vibes'), faster boots for refilling
the pool if it runs dry often (Kata VM templating, an initrd), what saving
commits, and the room: the trusted builder, the stamp (an
HMAC over the built script, so an edited copy shows as edited), and putting
sketches in the room.

## Shaders, as vibes has them (in progress)

The browser knows shaders only as vibes has them, never as arclamp does.
vibes' server takes in everything it hears (arclamp's scene and events,
builds, instances, and what browsers ask for) and sends browsers one list,
the stack, of vibes shaders: a superset of arclamp's, able to be a shader
that's still building, or couldn't go in, as well as one in the room. All
of the mediating, ids and positions included, is the server's.

- **One id, for a shader's whole life.** A shader's key is vibes' own: an
  instance's id for one put in from a sketch (the same while it builds and
  once it's live), or `rclamp-<id>` for one vibes only knows by arclamp's
  id (put in some other way). The browser never reads anything into a key.
- **Stages.** `building`, `failed` (couldn't go in, and why) and `live` come
  from the server; `draft` (a sketch you're adding, not applied) exists only
  in your browser, the same kind of shader as the rest.
- **Pending edits stay in the browser,** each person's own, keyed by shader
  key. A sketch you add is a draft shader at once: its build asked for then,
  its build's id sent with it on Apply, so what goes in is exactly what was
  built (and previewed), and the server carries it on from building to live.
- **Shaders made outside vibes** can be switched, moved and removed like
  any other. Removing one asks first: vibes only ever puts in its own
  builds, so it can't put one back.
- **Phase 1** (done; `src/server/shaders.ts`): the server sends the unified
  list (`{ shaders, roomtone }`, the stack top first), and routes take shader
  keys: mute, mask and remove one (`/api/shaders/<key>/…`), and the stack's
  order (`PUT /api/stack`, which moves them bottom first, one reorder at a
  time). The routes by arclamp's id are gone. A shader on its way in sits
  where it'll go in, on top, and can't be switched or moved yet; opened, it
  stays open as it goes in, since its key doesn't change.
- **vibes works with rclamp as it is** (master), not with the PRs below:
  they may not land. Where one would help, it's a later improvement, never
  a dependency.
- **Phase 2** (done): a shader on its way in, or one you're adding, can be
  switched, masked and moved like any other. vibes keeps what's wanted of
  one on its way in (muted, its whole mask, and its place: just above
  another shader's key, or the bottom; `POST /api/instances` takes them too,
  with the build that was previewed), shows it there in the stack, and puts
  it in that way: created at that position, then muted (if it's to be) and
  masked before its sandbox has started, one instance at a time so each
  goes where it's to go. What goes in is stamped v2, naming its shader
  (`shader=<key>`), so which shader is which can be read from the room
  itself: one put in just before vibes stopped is found by its stamp, not
  put in again. A panel open on a sketch you're adding stays open on the
  shader it becomes.
- **Phase 3** (done, then made the live state's: above): one socket between
  browser and server (`/api/scene/ws`), for the stack and for what's asked of
  it. Apply is one update, the draft's changes, which the server makes as one
  run, naming what it adds by the keys of the edits that add them (so a later
  change, in it or a later update, can name them too). It's answered once the
  tree shows it: done, or refused, and the browser keeps it pending; refused
  part way in arclamp, what was made before stays made (and so isn't pending
  any more). A shader gone meanwhile has nothing left to change, so that isn't
  refused. It isn't all or nothing in the room, since rclamp has no batch
  (with one, were it to land, it could be). The socket's origin is checked
  as every request's is; a refused one (a foreign origin, no session) is
  answered, not left hanging. The routes by key stay, for the panel's own
  actions and anything else.

## Params

A sketch can declare things for vibes to change while it runs, light by
light, with `param()` in the library (`packages/vibes/src/param.ts`): a
number (`param("speed", 0.05, { min: 0, max: 0.5 })`), a color
(`param("tint", "#f80")`) or a toggle (`param("on", false)`), its kind
its default's. A param is a field, each light's value, so it goes wherever
a value can depend on `here`. Each says which lights it's for: `lights`,
`{ kinds, tags, ids }` (a light passes every part given, and any value
within a part), so a toggle can be for old bulbs alone; a color is for
color lights only. The rules on both ends are the library's
(`packages/vibes/src/wire.ts`, re-exported by `src/shared/params.ts`).

- **In pools** (`src/server/pools.ts`). Params live in a pool: what's
  declared, and each param's values, by light (`pools/<pool>/declared`,
  `pools/<pool>/values/<param>/<light>` in the live state). Every running copy
  of a sketch's code has one, whatever runs it: each shader put in from a
  sketch (its instance's), a sketch being added (minted in the page that's
  adding it, which it takes into the room with it), and each preview of one
  in its box. A pool's id is whoever needs one's to mint. Anyone may set its
  values; only its owner may say what it declares: an instance's is its
  shader in the room's, otherwise whoever made it. Values are saved a second
  after they last changed; pools nothing has used for a day go.
- **Values are by light, and only by light.** There's no value for
  everywhere: setting one everywhere is setting it on every light. A value
  is kept if it's one of its param's kind, for a light the param's for (or,
  before anything's said what it declares, any value a param could have);
  one that stops being its param's is passed over wherever it's read.
  `PUT /api/shaders/<key>/params/<name>` takes `{ set: [[value, [ids]], …] }`
  (null back to the default), as updates to the pool do. A run of changes to
  one param of a shader in the room (a slider dragged) is logged as one entry.
- **Declared by whatever runs it.** What a sketch declares is what its code
  says as it runs, not what anything else makes of the script: in the room,
  its shader (so no other engine's differences can lose a param there); for
  a sketch you're adding, its preview on the map (`src/web/sim.ts`), so its
  knobs are there before it's in, and what's set on them goes in with it;
  in the editor, its preview in the box. A preview updated in place by HMR
  (only the modules edited run again) declares what those modules declare
  now: the library is told which are about to run again, and drops what they
  no longer declare (`retire`, `settle`; packages/vibes 0.3.1).
- **Over a stream** (`src/server/params.ts`). vibes links each instance's
  shader (by its stamp) once in its sandbox's life: an eval in arclamp,
  generated with JSON for data, calls `__vibes.connect` with where vibes is
  (`VIBES_SHADER_URL`) and a token of its pool's (its id and link number,
  signed; linking again makes older ones no good). The library opens
  `POST /shader-api/params`, saying what it declares, and vibes answers with
  an event stream: every value first (`state`), then each change in order
  (`change`), and something every 15 s. A new script in the same sandbox
  keeps the link and opens its own stream; a new sandbox (a respawn) is
  linked again. A stream that breaks opens again with every value, and one
  whose code can't keep up is dropped, never a change; so nothing's lost. A
  sandbox with no library to link (or one too old) isn't tried again until
  its script or sandbox is new. A preview in a box follows its own pool the
  same way: its extension gets a token from `/box-api/pools`, and sends each
  knob turned to `/box-api/pools/<pool>/values`, so the pool's the same on
  vibes as in the preview (and a page could turn its knobs too).
- **Shown and set.** The selection's panel has a control for each param a
  shader (or a sketch being added) has, for the lights selected that it
  lights and the param is for: a slider, room tone's color editor, or on and
  off. A change is a pending edit like a mute or a mask: the simulation hands
  the values to the shader's worker as the stream would (`__vibes.apply`), so
  it shows them before they're applied, and live mode applies them as they
  move. The editor's Sketch panel has knobs of its own, for every light: they
  change its preview at once, and its pool after.

Still to come: a shader that drops some of what it declares (or won't say)
only says so in vibes' log, not in the panel; and a page to turn a box
preview's knobs from elsewhere (a phone), which its pool already allows.

## Gaps in arclamp (PRs to rclamp)

1. **Shader logs.** `console.log` from a running shader only reaches arclamp's
   server log (`internal/scene/worker.go:493`); `/v1/scene/log` from the design
   doc was never built. The editor needs this.
2. **Change notifications**, so vibes can stop polling the scene: proposed as
   JCLemme/rclamp#17 (event streams for the scene, health and logs, and each
   frame's `touched` section on the websocket).
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
7. **Putting a shader in in one step**, for vibes' shaders: created already
   masked or muted (JCLemme/rclamp#21); an atomic batch of scene changes,
   with places anchored to other shaders (#23, stacked on #21); and a new
   shader passing its input through until its sandbox's first frame, instead
   of freezing the room while it starts (#22). vibes doesn't wait on any of
   them.
8. **A shader knowing its own id.** A sketch's params stream needs an eval to
   start in each new sandbox, as nothing in it says which shader it is; with
   that, the library could open its stream by itself.

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

Without a box or arclamp, the editor's Sketch panel runs as a page at
http://localhost:5173/preview/ (`pnpm dev:web`): `dev/sketch/main.ts`, built
as the builder builds it, on the real room if `dev/lights.json` has been
saved from vibes' `/api/lights` (src/web/preview/dev.tsx).

## To confirm

- RC OAuth endpoints: `https://www.recurse.com/oauth/authorize`,
  `/oauth/token`, and `/api/v1/profiles/me` for the profile.
