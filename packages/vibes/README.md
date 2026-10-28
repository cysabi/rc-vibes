# @roobscoob/vibes

Color, light and time for sketches on the lights at the
[Recurse Center](https://www.recurse.com): the room's color bulbs, 4×1
panels and old on/off bulbs, run by arclamp and made in vibes.

```sh
npm install @roobscoob/vibes
```

```ts
import { sketch, white, wave } from "@roobscoob/vibes";

// A slow warm wave rolls across the room.
export const update = sketch(({ x, t }) => white(2700, 30 + 400 * wave(t / 8 - x / 12)));
```

## One light, now

A sketch says what each light should make, a hundred times a second.
`sketch()` asks your function once per light per tick, and gives it `here`:

| | |
|---|---|
| `x`, `y` | where the light is, in meters from the building's top-left corner |
| `u`, `v` | the same, 0 to 1 across the room the lights fill (left to right, top to bottom) |
| `t` | seconds since the sketch started |
| `dt` | seconds since the last tick (about 0.01 in the room, 0.03 in the preview) |
| `now` | the frame's time, in ms since 1970 |
| `light` | the light itself: `id`, `kind` (`"color"` or `"switch"`), `tags`, `has(tag)`, `rail`, `random`, `below`, `state` |
| `room` | every light: `lights`, `rails`, `rail(id)`, `tagged(tag)`, `width`, `depth`, `center` |
| `at({ x, y, t })` | the same light, looking from somewhere else or at another time |

Return a color (anything that says one: see below), or `null` to leave the
light as the layers below have it. `sketch("#f80")` makes every color light
one color; `sketch(palettes.dusk)` lays a palette across the room.

- `light.rail` is `{ id, along, t, index, count }`: how far along its rail
  (meters, and 0 to 1), its place on it, and how many share it.
- `light.random` is a number from 0 to 1 of its own, the same every time.
- `light.below` is what the layers below this sketch make it, as a color, and
  `light.belowOn` whether that's on at all.
- `light.state` is the light's own memory, kept from tick to tick.

Something that isn't a color leaves its light as it is, with a warning in
the console, so one slip doesn't stop the sketch.

## Old bulbs

The old bulbs only switch, and look nothing like the color lights, so they
have a look of their own, apart from color's. Each look is named for the
kind of light it's for, as `light.kind` names them:

```ts
export const update = sketch({
  color: osc(3).color(palettes.dusk),   // the color bulbs and panels
  switch: osc(1, 0.25).thresh(),        // the old bulbs: on or off
});
```

`sketch(look)` is `sketch({ color: look })`: a color look is never asked
about old bulbs, and never switches them. Without a `switch` look they're
left as they are; `sketch(look, { switch })` gives one beside a color look.

A `switch` look gives `true` or `false`, a number (on at 0.5 or more, as
arclamp's own `on` channel: a field from 0 to 1 works, like
`noise(4).thresh(0.6)` or `clock(96).every(1).env()`), `"on"` or `"off"`, or
`null` to leave the bulb as it is. It can be a function of `here`, a field,
or one answer for every old bulb: `sketch({ switch: true })`.

## Colors

A color is light: a hue and chroma (OKLab's a and b at full lightness), and
an amount of light in **lumens**. Lumens are absolute, the same on every
light: 800 lm is a bright bulb, 20 lm a glow, whichever bulb it lands on.

Colors never change. Read them with properties, and change them with
methods, each giving a new color:

```ts
const warm = white(2700).at(400);
warm.mix("#ff8800", 0.3).fade(0.5);
light.below.shiftHue(20).dim(0.8);   // a filter over what's below
```

### Making them

```ts
white(2700, 400)            // a white by color temperature, 400 lm
lemtone(265, 0.3, 40)       // the lights' own: hue, chroma at full lightness, lumens
oklch(0.7, 0.2, 265)        // CSS's oklch()
hsl(240, 1, 0.5)            // the familiar wheel: 0 red, 120 green, 240 blue
rgb(1, 0.5, 0)              // 0–1, or 0–255
hex("#ff8800")
xy(0.3127, 0.329, 500)      // CIE 1931 chromaticity, lumens
color(anything)             // anything below
off
```

Screens' spaces (RGB, hex, HSL, OKLCh, …) count a screen's white as a fixed
1000 lm: `#ffffff` is 1000 lm, `#0000ff` about 72, `oklch(0.5 0 0)` 125, as
dim next to white as on a screen. `white()` and `lemtone()` take lumens
straight (1000 if not given), and `.at(lm)` sets them on any color.

Hues in the lights' own terms (`lemtone`, `c.hue`) are OKLab's: about 30°
red, 110° yellow, 145° green, 195° cyan, 265° blue, 330° magenta. They're
not HSL's, which is why `hsl()` is its own maker. Chroma: 0 is white, 0.1
pale, 0.3 strong.

### Anything that says a color

Wherever a color goes (`color()`, `.mix()`, `.add()`, palettes, fields,
what your look returns, `sketch()` itself), anything that says one will do:

| | |
|---|---|
| text | any CSS color: `"#f80"`, `"ff8800cc"`, `"orange"`, `"rgb(255 136 0 / 50%)"`, `"hsl(30deg, 100%, 50%)"`, `"hwb(…)"`, `"oklch(70% 0.2 265)"`, `"oklab(…)"`, `"lab(…)"`, `"lch(…)"`, `"color(display-p3 1 0 0)"` |
| | color temperatures: `"2700K"`, `"2700 kelvin"`, `"candlelight"`, `"incandescent"`, `"halogen"`, `"daylight"` |
| | the lights' own: `"lemtone(265 0.3 40)"`, and `"265° C0.300 · 40 lm"` (as a color prints itself) |
| | with lumens or fidelity alongside: `"#f80 · 120 lm"`, `"2700K @ 400lm"`, `"orange 50 lumens"`, `"… · F0.5"` |
| a number | a color temperature in kelvin: `2700` |
| a list | `[r, g, b]` or `[r, g, b, alpha]`, 0–1 or 0–255 |
| an object | `{ a, b, lm }`, arclamp's channels `{ a, b, brightness, fidelity }`, `{ r, g, b }`, `{ h, s, l }`, `{ l, c, h }`, `{ hue, chroma, lm }`, `{ kelvin, lm }`, `{ x, y }`, an old bulb's `{ on }`, with `lm`, `lumens`, `brightness` or `fidelity` on any |
| nothing | `null` or `undefined` is `off` |

Alpha is less light: `#ff880080` is half the lumens of `#ff8800`.
Something it can't read throws, saying what it would take.

### Reading them

| | |
|---|---|
| `c.lm`, `c.brightness` | lumens; arclamp's units (1.0 is 1000 lm) |
| `c.hue`, `c.chroma` | in the lights' own terms |
| `c.kelvin`, `c.nearestKelvin` | its color temperature if it's a white (else null); the nearest white's |
| `c.looks` | how bright it looks, 0–1 (1000 lm and up is 1) |
| `c.hex`, `c.rgb`, `c.hsl`, `c.oklch`, `c.oklab`, `c.xy`, `c.xyz` | in other spaces, on the same 1000 lm scale (`rgb` goes past 1 when brighter) |
| `c.channels` | arclamp's channels |
| `` `${c}` `` | `"2700 K · 400 lm"`, which `color()` reads back |

### Changing them

| | |
|---|---|
| `.at(lm)` | the same color at `lm` lumens |
| `.dim(k)`, `.fade(k)` | k times the lumens; looks k times as bright |
| `.mix(other, t)` | toward another color by t (0.5 if not given), evenly as it looks; to or from dark, only brightness changes |
| `.add(...others)` | lights shining together, added up as light |
| `.shiftHue(deg)`, `.saturate(k)` | |
| `.with({ … })` | any of `a`, `b`, `hue`, `chroma`, `kelvin`, `lm`, `brightness`, `fidelity` changed |
| `.vivid()` | dimmed to what a color bulb makes of it, so it isn't paled |

### Palettes

`palette(a, b, c)` is colors from 0 to 1: `palette(a, b, c)(0.5)` is `b`.
Stops can be anything that says a color, in a list, or placed:
`palette([0, "black"], [0.2, "#f80"], [1, 6500])`. Outside 0–1 it holds the
ends. `palettes.dusk`, `.sea`, `.ember` and `.aurora` start you off, each
dark to bright, within what the bulbs make.

### What bulbs make

**Saturated colors are dim.** A color bulb's strongest blue tops out near
30 lm; asked for more, a bulb keeps the lumens and pales the color toward
white. `c.vivid()` dims it instead, so it stays the color you asked for, and
`br30.maxLm(c)` says how bright a color can be on a color bulb (`br30` is
arclamp's name for them). Whites go brightest around 4000 K (about 950 lm),
and 2700 K reaches about 500; the bulbs go no warmer than about 1800 K, and
only dimly there. 4×1 panels have no model yet.

## Fields

A field is a pattern over the room and time: a function of `here`, with
methods to chain. Sources make numbers from 0 to 1, a palette makes them
colors, and `sketch()` takes the result.

```ts
import { sketch, osc, noise, palettes } from "@roobscoob/vibes";

export const update = sketch(
  osc(3, 0.05)                    // 3 bands across the room, each light going round 0.05 times a second
    .rotate(({ t }) => t * 6)     // any number can be a function of here: 6° a second
    .kaleid(5)
    .warp(noise(2, 0.1), 1.5)     // pushed up to 1.5 m by slow noise
    .color(palettes.dusk),
);
```

Sources count across the room's width, from its center.

| Sources | |
|---|---|
| `osc(n, speed, phase)` | smooth bands, n across the room |
| `noise(n, speed)` | smooth noise, blobs about n across |
| `rings(n, speed)` | rings out from the center |
| `gradient(degrees)` | 0 to 1 across the room: 0° left to right, 90° top to bottom |
| `voronoi(n, speed)` | drifting cells, 0 at their centers |
| `solid(value)` | the same everywhere, a number or a color |
| `field(fn)` | your own function of here, to chain onto |

`speed` is how many times a second each light goes round.

| Methods | |
|---|---|
| `.rotate(deg)`, `.scale(k)`, `.move(dx, dy)`, `.kaleid(n)`, `.warp(field, meters)` | where it looks |
| `.delay(seconds)`, `.speed(k)` | when it looks: `.delay(({ u }) => 2 * u)` runs later across the room |
| `.pow(k)`, `.steps(n)`, `.thresh(level)`, `.invert()`, `.mul(k)`, `.add(x)`, `.mix(x, t)` | numbers |
| `.color(palette)` | numbers to colors: a palette, a list of stops (`["black", "#f80", "white"]`), one color (dark to it), or your own function |
| `.at(lm)`, `.dim(k)`, `.fade(k)`, `.boost(by, amount)`, `.shiftHue(deg)`, `.saturate(k)`, `.vivid()`, `.add(color)`, `.mix(color, t)` | colors |
| `.map(fn)` | your own change: `.map((v, here) => ...)` |
| `.only(test)` | just some lights: `.only((light) => light.rail)` |

Transforms move where and when a field looks, never which light it is.

## Both at once

A field is a function of `here`, so your function can read one, and
`field()` makes your function chainable:

```ts
const petals = osc(3, 0.05).rotate(({ t }) => t * 6).kaleid(5);

export const update = sketch((here) => {
  const { light, t } = here;
  if (light.rail) return palettes.sea(petals(here)).vivid();   // bulbs on rails show the petals
  return white(2200, 200 * wave(t / 4 + light.random));       // panels breathe, each on its own beat
});
```

Nothing needs a chain: every transform is also a plain function on `here`
(`rotate(here, 30)`, `kaleid(here, 5)`, `delay(here, 1)`, …).

## Time

Waves count in cycles and run 0 to 1: `wave(t / 8)` goes round every 8 s.

| | |
|---|---|
| `wave`, `saw`, `tri`, `square(x, duty)` | smooth, rising, up and down, on and off |
| `ease.in`, `ease.out`, `ease.inOut`, `smoothstep`, `lerp`, `remap`, `clamp`, `fract` | |
| `noiseAt(x, y, z)` | smooth noise from any numbers |
| `hash(...ns)` | a number from 0 to 1 that's the same for the same inputs |
| `decay(dt, halfLife)` | `v *= decay(dt, 2)` halves v every 2 s |
| `chance(perSecond, dt)` | true as often as something happening that many times a second |

The room ticks about three times as often as the preview, so anything done
each tick should use `dt`: `decay` and `chance` do.

A clock counts beats, for wiring into any number a field takes:

```ts
const beat = clock(96);
const hit = beat.every(1).env({ attack: 0.02, release: 0.45 });   // 0 → 1 → 0 on every beat
const turn = beat.every(4).seq([0, 45, 90, 135]);                 // a hard step each bar
const look = beat.every(16).seq([palettes.dusk, palettes.sea]);

export const update = sketch(osc(4, 0.1).rotate(turn).kaleid(6).color(look).boost(hit, 0.8));
```

`every(n)` also gives `count`, `ramp` (0 to 1 between marks) and `since`.

## The show

`show` is the room's one show clock, played, stopped, tapped and synced from
vibes' transport. Every sketch reads it at its frame's own time, so all of
them agree, to the frame, where the piece is and which beat it's on.

| | |
|---|---|
| `show.time` | where the piece is, in seconds |
| `show.playing` | whether it's running |
| `show.beat` | beats gone by, counting up smoothly (playing or not); 0 with no tempo |
| `show.bar` | bars gone by (4 beats each): a whole number is a downbeat |
| `show.bpm` | the tempo; 0 with none |
| `show.clock` | the tempo as a clock, for `every`, `env` and `seq` on the room's beats |

```ts
const hit = show.clock.every(1).env({ release: 0.4 });          // a flash on every beat of the room's
const look = show.clock.every(4).seq([palettes.dusk, palettes.sea]); // a new look each bar

export const update = sketch(osc(3, 0.1).color(look).boost(hit, 0.8));
```

With no show on, the clock rests: playing, at `RESTING_BPM` (120) on a beat
every sketch shares, so a sketch that moves on the beat looks right anyway.
Starting a show in vibes keeps that beat going and puts the piece at 0:00,
stopped; ending one rests the clock again. Till vibes says otherwise (or run
anywhere without it), it rests too, with `show.time` counting from the
sketch's start.

## Params

A param is something vibes can change while the sketch runs, light by light:
a number, a color, or a toggle. In vibes, select some lights on the map and
the sketch's panel has a control for each param they're for; to set one
everywhere, select every light.

```ts
import { osc, param, palettes, sketch } from "@roobscoob/vibes";

const speed = param("speed", 0.05, { min: 0, max: 0.5 });
const tint = param("tint", "#f80");
const on = param("on", false, { lights: "switch" });

const wave = osc(3, speed);
export const update = sketch({ color: (here) => tint(here).at(600 * wave(here)), switch: on });
```

`param(name, default, options)` gives a field: `speed(here)` is this light's
value, or the default until vibes sets one. Its kind is its default's: a
number (with `min`, `max` and `step`, the slider's; a value is always kept
within them), `true` or `false`, or anything that says a color. `label` is
what vibes calls it.

`lights` says which lights it's for: a kind (`"color"` or `"switch"`, as
`light.kind`), kinds, or `{ kinds, tags, ids }`, each one or a list. A light
passes if it passes every part given, and any one value in a part will do.
Every light, if not given; a color is only ever for color lights. vibes only
offers a param for the lights it's for, and any other light reads its
default.

vibes learns what a sketch declares from the sketch itself, as it runs (in the
room; in vibes' preview of it, before it's in; in the editor's preview), and
streams it each value as it changes; nothing is needed in the sketch beyond
the declaration. A param you rename or delete goes from the editor's knobs as
you save, though the preview carries on without reloading.

## Without sketch()

`sketch()` makes arclamp's `update(prev, nowMs, initialMs)`, which you can
write yourself: it gets every light (`id`, `channels`, `tags`, `coords`,
`rail`) and returns `{ lights: [{ id, channels }] }`. Color lights' channels
are `a`, `b`, `brightness` (1.0 = 1000 lm) and `fidelity`; old bulbs' is `on`.
`color(light.channels)` reads a light's channels, and `c.channels` writes
them. The types are `Prev`, `Out` and `Update`.

Animate by `initialMs`: it's the frame's time, when the room tone made it,
the same for every layer, so layers stay in step. `nowMs` is only this
layer's own clock, a few tens of milliseconds later, and not when the
shader started: `nowMs - initialMs` stays about the same forever.

## Working on this library

It lives in vibes (`packages/vibes`). `node packages/vibes/scripts/gamut.ts`
remakes the color bulbs' table from vibes' model of them; `npm run build` in
this folder makes `dist/`.

MIT licensed.
