# vibes

A web UI for [arclamp](https://github.com/JCLemme/rclamp), the programmable
lights at the Recurse Center: watch the room live, and write, edit, reorder and
mute the shaders that drive it. Recursers log in with their RC account; vibes
talks to arclamp on their behalf with one service key.

Design, decisions and what's next: [PLAN.md](PLAN.md).

## Run it locally

Needs Node 24, pnpm, and Nix (to build arclamp with rclamp's own toolchain).
The arclamp source defaults to `~/Documents/JCLemme/rclamp`; set `ARCLAMP_SRC`
to use another checkout.

```sh
pnpm install
pnpm arclamp:build   # compile arclamp and its V8 sandbox into .arclamp/bin
pnpm arclamp:setup   # production's light list, a local "vibes" token, and .env
pnpm arclamp         # local arclamp in simulation mode (no radio)
pnpm dev             # vibes at http://localhost:5173 (log in with any name)
pnpm arclamp:seed    # a few test shaders in the room (--clear starts over)
pnpm sketches:seed   # a few sketches made, built and put in the room (sketches on)
```

`pnpm arclamp:radio` runs the local arclamp against a base station plugged into
this Mac instead, on production's channel: every bulb in range follows it.

Sketches need Docker for their boxes and builds. Without it, `SKETCHES=1
BOX_RUNNER=local VIBES_SIGNING_KEY=<32+ chars>` in `.env` builds sketches as
plain processes on this machine (no boxes: edit a sketch's repo in `sketches/`
by hand), enough to put sketches with params in the room.

## Checks

```sh
pnpm typecheck
pnpm test
pnpm build           # frontend into dist/web; `pnpm start` serves it
```
