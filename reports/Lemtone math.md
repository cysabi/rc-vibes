# Lemtone math

A self-contained specification of Lemtone as rc-vibes implements it
(`src/shared/lemtone.ts`, `src/shared/bulb.ts`, `src/shared/bulb.model.ts`,
`src/web/wheel.ts`), precise enough to reimplement bit-for-bit (to float64
rounding).

**Provenance.** The canonical Lemtone is Walter's `rc-bulb-firmware`,
directory `lemtone/` (C firmware `lemtone.c`, model `lemtone_model.json`,
reference solve `calibration/lemtone_ref.py`, tool page
`web/lemtone_tool.template.html`). vibes' solver is a line-for-line port of
`lemtone_solve`. It reproduces all 309 of the firmware's float64 reference
vectors with matching modes, a worst duty error of 8.3e-9 (exact mode) or
8.9e-8 (desat/clamp), and a worst desat error of 5e-10. The firmware runs the
same algorithm in float32. vibes' version is float64, which is what the reference
vectors come from.

**Numerics.** Unless stated otherwise, all arithmetic is IEEE-754 double precision. `cbrt` is
the real, sign-preserving cube root (`cbrt(-8) = -2`). `hypot(x, y) = √(x²+y²)`.
`clamp(v, lo, hi) = v < lo ? lo : v > hi ? hi : v`. Text formatting uses JavaScript
semantics: `Math.round` rounds half toward +∞, and `x.toFixed(n)` rounds the
*exact* binary value half-up (unlike Python's half-even `format`).

---

## 1. The value

A lemtone is a 4-tuple **T = (a, b, B, F)**:

| field | meaning | domain |
|---|---|---|
| `a`, `b` | Color: OKLab a and b **at L = 1**. | ℝ (the real colors fill a bounded region around 0) |
| `B` = `brightness` | Luminous flux in units of 1000 lm. This is a fixed absolute unit, not a fraction of any light's maximum. | B ≤ 0 is off; there is no upper bound |
| `F` = `fidelity` | Where the solver sets the white LEDs within their feasible range. 0 = least white-LED light (pale colors and whites built from R, G, B). 1 = most. | [0, 1] (the solver clamps it) |

**Why "at L = 1" makes color independent of intensity.** OKLab is a linear map
of the cube root of linear LMS, which is itself linear in XYZ. Scaling XYZ by k
scales (L, a, b) by k^(1/3), so (a/L, b/L) depends only on chromaticity. Every
chromaticity is one ray through the origin of OKLab, and a lemtone names that
ray by where it crosses L = 1. (a, b) = (0, 0) is OKLab's white point, which is approximately D65.
D65 itself lands at (−1.009e−5, −8.611e−5) with these constants.

**Polar form (OKLCh at L = 1).** hue h = atan2(b, a) in degrees, plus 360 if
negative, so h ∈ [0, 360). chroma C = hypot(a, b). The inverse is
a = C·cos(h·π/180), b = C·sin(h·π/180).

**Transport (arclamp channels).** A color light has numeric channels `a`, `b`,
`brightness`, `fidelity`. Missing channels default to `a = 0`, `b = 0`,
`brightness = 0`, `fidelity = 1`. A light is dark when brightness ≤ 0. Old relay
bulbs have a single channel `on`, which is on when `on ≥ 0.5`. They are displayed
as the fixed lemtone (whiteAB(2700 K), B = 0.8, F = 1).

---

## 2. Color-space constants and conversions

All matrices are row-major, and the product is `M·v`. Use these exact decimals. The
inverses are Ottosson's published values, not a numerical inverse of the
forward matrices, and the code uses each matrix only where noted.

```
M1  (XYZ → LMS, linear)
  [ 0.8189330101,  0.3618667424, -0.1288597137 ]
  [ 0.0329845436,  0.9293118715,  0.0361456387 ]
  [ 0.0482003018,  0.2643662691,  0.633851707  ]

M2  (LMS' = cbrt(LMS) → Lab)
  [ 0.2104542553,  0.793617785,  -0.0040720468 ]
  [ 1.9779984951, -2.428592205,   0.4505937099 ]
  [ 0.0259040371,  0.7827717662, -0.808675766  ]

M2inv (Lab → LMS')
  [ 1.0,  0.3963377774,  0.2158037573 ]
  [ 1.0, -0.1055613458, -0.0638541728 ]
  [ 1.0, -0.0894841775, -1.291485548  ]

M1inv (LMS → XYZ)
  [  1.2270138511, -0.5577999807,  0.281256149  ]
  [ -0.0405801784,  1.1122568696, -0.0716766787 ]
  [ -0.0763812845, -0.4214819784,  1.5861632204 ]
```

**XYZ → OKLab:** `lms = M1·X; lms' = cbrt(lms) (elementwise); Lab = M2·lms'`.

**XYZ → lemtone color:** `ab(X) = (Lab₁ / Lab₀, Lab₂ / Lab₀)` where `Lab = xyzToOklab(X)`.

**Chromaticity → XYZ:** `xyToXyz(x, y) = (x/y, 1, (1 − x − y)/y)`.
`abOfXy(x, y) = ab(xyToXyz(x, y))`.

**XYZ → chromaticity:** `xy(X) = (X₀/S, X₁/S)` with `S = X₀+X₁+X₂`, or `(0, 0)` if S ≤ 0.

**Lemtone color → XYZ with Y = 1** (used only by the solver):
```
lms' = M2inv · (1, a, b)
lms  = (lms'₀³, lms'₁³, lms'₂³)        // computed as v·v·v
X    = M1inv · lms
if not (X₁ > 1e-6): undefined         // no real color there
return X / X₁
```

---

## 3. Whites (color temperature)

**Planckian locus**, the Kim et al. cubic spline as in Walter's tool page. It is
evaluated with no clamping of K. It is valid for 1667–25000 K, and the UI offers 1700–10000 K.
```
cctToXy(K):
  t = 1000 / K;  t2 = t·t;  t3 = t2·t
  x = K ≤ 4000 ? −0.2661239·t3 − 0.2343589·t2 + 0.8776956·t + 0.17991
               : −3.0258469·t3 + 2.1070379·t2 + 0.2226347·t + 0.24039
  x2 = x·x;  x3 = x2·x
  y = K ≤ 2222 ? −1.1063814·x3 − 1.3481102·x2  + 2.18555832·x − 0.20219683
    : K ≤ 4000 ? −0.9549476·x3 − 1.37418593·x2 + 2.09137015·x − 0.16748867
    :             3.081758·x3  − 5.8733867·x2  + 3.75112997·x − 0.37001483
  return (x, y)

whiteAB(K) = abOfXy(cctToXy(K))
```

**Kelvin of a color** (`kelvinOf(a, b, tol = 0.005)`): this returns the color temperature of
the nearest point on the locus, or *none* if that point is farther than `tol`
(Euclidean, in the a/b plane). Pass tol = ∞ to always get the nearest white. The search runs in mired (m = 10⁶/K), coarse then fine.
Reproduce it exactly as written, because the loop bound reads a variable that changes inside the loop:
```
best = 0; bestD = +∞
look(m): (wa, wb) = whiteAB(1e6 / m); d = hypot(wa − a, wb − b)
         if d < bestD (strict): bestD = d; best = m

m = 1e6/10000                      // = 100
while m ≤ 1e6/1700:  look(m); m += 2          // 100, 102, …, 588
m = best − 2
while m ≤ best + 2:  look(m); m += 0.02       // NB: `best` is re-read each test, so the
                                              // window extends if best moves; m accumulates
                                              // by repeated += 0.02 (float drift included)
return bestD ≤ tol ? 1e6 / best : none
```

---

## 4. Display (screen colors)

Two gamuts are used: `srgb` and `display-p3`. Both use the sRGB transfer function.

```
LMS_RGB.srgb (Ottosson's linear-LMS → linear sRGB)
  [  4.0767416621, -3.3077115913,  0.2309699292 ]
  [ -1.2684380046,  2.6097574011, -0.3413193965 ]
  [ -0.0041960863, -0.7034186147,  1.707614701  ]

LMS_RGB.display-p3 (the above composed with sRGB→XYZ→P3, CSS Color 4)
  [  3.1277689872, -2.2571357962,  0.129366809  ]
  [ -1.0910090478,  2.4133317587, -0.3223227108 ]
  [ -0.026010813,  -0.5080413259,  1.5340521389 ]

LUMA.srgb       = (0.2126729, 0.7151522, 0.072175)
LUMA.display-p3 = (0.2289746, 0.6917385, 0.0792869)
```

**Linear RGB of a color (`linearOf`)**: OKLab at L = 1 → LMS → RGB, with
out-of-gamut components dropped:
```
l = (1 + 0.3963377774·a + 0.2158037573·b)³      // pow(·, 3)
m = (1 − 0.1055613458·a − 0.0638541728·b)³
s = (1 − 0.0894841775·a − 1.291485548·b)³
rgb = LMS_RGB[gamut] · (l, m, s);  rgb_k = max(0, rgb_k)
```

**sRGB OETF:** `γ(v) = v ≤ 0.0031308 ? 12.92·v : 1.055·v^(1/2.4) − 0.055`.

**Swatch.** This is the brightest displayable color with this hue and chroma, gamma-encoded in [0, 1]:
`top = max(rgb)`, or 1 if that max is 0. The result is `swatch = (γ(r/top), γ(g/top), γ(b/top))`.

**Light RGB.** This is linear RGB scaled to a luminance of 1, so a light can be scaled by lumens and summed:
`Y = LUMA·rgb`, or 1 if that is 0. The result is `lightRgb = rgb / Y`.

**How bright a light looks.** `look(B) = min(1, cbrt(max(0, B)))`. Anything at 1000 lm or above counts as full.

**Lemtone as a CSS color.** A null lemtone gives `"rgb(0 0 0)"`. Otherwise use `swatch(a, b, gamut) · look(B)`, formatted as follows:
- sRGB: `rgb(R G B)` with each channel `Math.round(v·255)`.
- P3: `color(display-p3 r g b)` with each channel `String(+v.toFixed(4))`. The unary `+` drops trailing zeros, so 1 prints as `1` and 0.5000 as `0.5`.
- If alpha < 1, add ` / ` followed by `String(+alpha.toFixed(3))` before the closing parenthesis.

---

## 5. Text

```
lumensText(B):  lm = B·1000
                (lm ≥ 9.95 or lm == 0) ? String(Math.round(lm)) : lm.toFixed(1)   then + " lm"
                // 0.8 → "800 lm", 0.025 → "25 lm", 0.0025 → "2.5 lm", 0.00995 → "10 lm"

colorName(a, b): k = kelvinOf(a, b)            // default tol 0.005
                 k ≠ none ? `${Math.round(k/50)·50} K`
                          : `${Math.round(hue)}° C${chroma.toFixed(2)}`   // may print 360°

lemtoneCode(T) = `${colorName(a,b)} · ${lumensText(B)} · F${F.toFixed(2)}`
                 // separator is space, U+00B7 MIDDLE DOT, space; degree is U+00B0
```

---

## 6. The bulb: forward model

A color bulb (BR30) has five channels, indexed **i = 0..4 = r, g, b, ww (warm
white), cw (cool white)**. Each takes a light-equivalent duty
dᵢ ∈ [0, d_max] with **d_max = 0.8**. The model gives the light, as XYZ in model units, for any duty vector d:

```
XYZ(d) = Σ_{i : dᵢ > 0}  dᵢ · gᵢ(d) · Tᵢ(dᵢ)
lumens = XYZ₁ · lmPerY,      lmPerY = 0.108595447
```
So brightness 1.0 (1000 lm) means Y = 1000 / 0.108595447 ≈ 9208.49 model units.

**Per-unit-duty color Tᵢ(d).** This is piecewise-linear over the channel's 5 knots kᵢ,
with values XYZᵢ, held constant outside the knot range. Note that T(0) = the first knot's value:
```
if d ≤ k[0]: return XYZ[0]            // also when there is only one knot
if d ≥ k[n−1]: return XYZ[n−1]
j = 1; while d > k[j]: j += 1         // smallest j with d ≤ k[j]
t = (d − k[j−1]) / (k[j] − k[j−1])
return XYZ[j−1] + t·(XYZ[j] − XYZ[j−1])   // per component
```

**Interaction (supply sag) gᵢ(d).** This factor is 1 when there is no sag. Let o = (d_j for j ≠ i, in
increasing j), which is four values. For example, for i = ww, o = (d_r, d_g, d_b, d_cw).
θᵢ has 18 coefficients, and the terms are summed in this order:
```
g = 1
for p in 0..3:           g += θᵢ[p]     · o_p                // f = 0..3
for p in 0..3:           g += θᵢ[4+p]   · o_p · dᵢ            // f = 4..7
f = 8
for p in 0..3: for q in p..3:  g += θᵢ[f] · o_p · o_q; f += 1  // f = 8..17:
      // (0,0),(0,1),(0,2),(0,3),(1,1),(1,2),(1,3),(2,2),(2,3),(3,3)
```

**Model data.** This is calibration `thermal_20260926_104045_bulb55_main+static`,
generated from the firmware's `lemtone/lemtone_model.json`. Use it verbatim:
```js
knots: [   // per channel: r, g, b, ww, cw
  [0.050728419, 0.100728419, 0.200728419, 0.400728419, 0.800728419],
  [0.0504680752, 0.100468075, 0.200468075, 0.400468075, 0.800468075],
  [0.0504383694, 0.100438369, 0.200438369, 0.400438369, 0.800438369],
  [0.0507088379, 0.100708838, 0.200708838, 0.400708838, 0.800708838],
  [0.0507419908, 0.100741991, 0.200741991, 0.400741991, 0.800741991],
],
xyz: [     // per channel, per knot: [X, Y, Z] per unit duty
  [[1333.65685, 571.2322, 0.183539331], [1327.64845, 568.512279, 0.759097317], [1321.61494, 564.994579, 0.243236474], [1319.57813, 564.632774, 0.103863753], [1294.75996, 553.77956, 0.565640465]],
  [[229.622165, 1279.06648, 248.16745], [231.146701, 1280.28754, 249.937163], [242.506541, 1317.72052, 258.408604], [258.433203, 1352.12689, 271.303599], [287.281926, 1409.30744, 292.512958]],
  [[1819.38496, 296.482909, 9851.31753], [1801.49343, 292.676213, 9756.80702], [1807.42613, 286.578922, 9797.31531], [1810.44401, 299.601683, 9811.7788], [1827.97838, 320.848201, 9867.4438]],
  [[7536.55446, 6666.53327, 2417.3915], [7524.08117, 6653.70856, 2414.61943], [7577.09347, 6690.22923, 2416.38347], [7735.9525, 6842.76276, 2532.42444], [7837.20892, 6941.30014, 2635.22304]],
  [[6759.69301, 7196.59271, 7619.47021], [6752.50821, 7187.14649, 7621.90253], [6755.60678, 7183.62825, 7647.8111], [6897.37061, 7326.14058, 7855.46597], [7074.15531, 7494.54445, 8156.48509]],
],
theta: [   // per channel, 18 coefficients each
  [-0.220219878, -0.0868475297, -0.32976011, -0.122681674, 0.113978139, -0.0813434747, -0.0603716753, 0.13161034, 0.155839179, 0.0436446946, -0.116264993, -0.0437904904, -0.00675416504, 0.127133063, -0.0379423631, 0.262637646, 0.0746957042, 0.0310118693],
  [0.08215982, 0.0172197675, -0.0568295055, 0.0269746826, -0.0503650952, -0.0166432258, -0.0446257467, -0.0290867361, -0.0379892195, -0.0108247722, -0.0630560663, -0.0794347029, -0.00592436666, -0.00852710952, -0.12295586, 0.12622288, -0.150086667, -0.0109116387],
  [0.0147357249, 0.0277068715, 0.15429752, 0.205233999, 0.0120708639, -0.0702252584, -0.194221778, -0.15449249, 0.00275609676, -0.0295884713, -0.089655674, -0.0686696873, 0.0172608817, -0.029227584, -0.103549012, -0.0205265799, -0.327110151, -0.135321242],
  [0.0693636939, 0.0739203925, 0.0665896033, -0.087287508, -0.0521398214, -0.0862583754, -0.0835137657, -0.230570107, -0.0141805712, -0.0574753638, 0.0155777978, -0.0143051679, -0.00762045706, -0.0740935217, -0.14484897, -0.0268129315, -0.112984107, 0.039295449],
  [0.0174169272, 0.0784129992, 0.0881969241, 0.0422230103, -0.0189825874, -0.0922940645, -0.0265344381, -0.39430883, 0.0385598495, 0.0271414477, -0.0688543291, -0.124487285, -0.0254942567, -0.0733140052, -0.194463446, -0.0696447749, -0.0694475074, 0.00995341622],
],
dutyMax: 0.8,
lmPerY: 0.108595447,
```

---

## 7. The bulb: solve (lemtone → duties)

### Constants
```
REF_DUTY = 0.4     PHASE1_ROUNDS = 6     FIX_ROUNDS = 12
FIX_TOL = 2e-3     BISECT_STEPS = 10     EPS = 1e-6     d_max = 0.8
```
**Precomputed values.** The reference primaries are `P⁰ᵢ = Tᵢ(0.4)`, which have no sag. The white-LED colors are
`CW_AB = ab(P⁰_cw)` and `WW_AB = ab(P⁰_ww)`.

### Helpers
```
β(c, w, p) = clamp( ((p−c)·(w−c)) / |w−c|², 0, 1 )   // 2-D projection onto segment c→w; 0 = c, 1 = w

inv3(P): inverse of the 3×3 matrix whose COLUMNS are P_r, P_g, P_b (XYZ each);
         standard adjugate/determinant; fail if |det| < 1e-12

localPrimaries(d, sag): Pᵢ = Tᵢ(dᵢ) · (sag ? gᵢ(d) : 1)   for ALL i, including dᵢ = 0
         // so that XYZ(d) = Σ dᵢ Pᵢ exactly; zero-duty channels still have a primary
         // (T at the first knot), which keeps the RGB matrix invertible
```

### Closed form on a linear model
`closedForm(P, tgt, p, f)`: for a linear model XYZ = Σ dᵢ Pᵢ, find duties that give
target XYZ `tgt`, where `p = xy(tgt)` is the target's chromaticity. The white LEDs are split by where p
projects onto *this model's* CW→WW chromaticity line. The total white level
`w_e` goes to fraction f of its feasible range, and R, G, B take the rest.
```
A = inv3(P)                     ; fail → infeasible
β = β(xy(P_cw), xy(P_ww), p)   // in CIE xy, using the CURRENT P (it moves between rounds)
wmix = (1−β)·P_cw + β·P_ww
u = A·tgt;  v = A·wmix          // rgb(w_e) = u − w_e·v
lo = 0
hi = d_max / max(β, 1−β, EPS)   // both white duties ≤ d_max
tol = EPS·d_max
for k in 0,1,2:                 // require 0 ≤ u_k − w_e·v_k ≤ d_max
  if |v_k| < 1e-12:
    if u_k < −tol or u_k > d_max + tol: infeasible
    continue
  l = (u_k − d_max)/v_k;  h = u_k/v_k
  if v_k < 0: swap(l, h)
  lo = max(lo, l);  hi = min(hi, h)
if hi < lo − tol: infeasible
w_e = lo + f·max(0, hi − lo)
d_k  = clamp(u_k − w_e·v_k, 0, d_max)   for k = r, g, b
d_ww = clamp(w_e·β,       0, d_max)
d_cw = clamp(w_e·(1−β),   0, d_max)
```
Fidelity therefore means: f = 0 uses the least white-LED output that keeps RGB in
range, and f = 1 uses the most.

### Fixed-point rounds
```
rounds(tgt, p, Y, f, sag, maxRounds, P, d):
  repeat maxRounds times:
    next = closedForm(P, tgt, p, f)
    if infeasible: return {converged: false, feasible: false, P, d}   // P, d from before this round
    d = next
    P = localPrimaries(d, sag)
    worst = max over c∈{X,Y,Z} of |tgt_c − Σᵢ dᵢ·Pᵢ,c|
    if worst < FIX_TOL·Y: return {converged: true, feasible: true, P, d}
  return {converged: false, feasible: true, P, d}
```

### One attempt at an XYZ target
```
attempt(tgt, f):
  Y = tgt₁
  if not (Y > 0) or tgt₀ < 0 or tgt₂ < 0: fail           // not a real color
  p = xy(tgt)
  one = rounds(tgt, p, Y, f, sag=false, PHASE1_ROUNDS, P⁰, zeros(5))
  P   = (not one.converged and not one.feasible) ? P⁰ : localPrimaries(one.d, sag=true)
  two = rounds(tgt, p, Y, f, sag=true, FIX_ROUNDS, P, one.d)
  return two.converged ? two.d : fail

attemptAb((a, b), Y, f):
  X = lemtone-color→XYZ(a, b)   (§2; Y = 1)  ; undefined → fail
  return attempt(Y·X, f)
```
Phase 1 settles the white/RGB split without sag. Phase 2 corrects for sag
starting from there. Going straight to phase 2 can lock onto a worse fixed point.

### Solve
`solve(a, b, lm, F)` → `{duty[5], mode ∈ {off, exact, desat, clamp}, desat ∈ [0,1], lm}`
```
if not (lm > 1e-9) or a is NaN or b is NaN:  return {zeros, off, desat 0, lm 0}
f = clamp(F, 0, 1)
Y = lm / lmPerY
q = (a, b)

d = attemptAb(q, Y, f)
if d: return {d, exact, 0, lm}

// The target's own point on the bulb's white line, in the lemtone a/b plane:
β = β(CW_AB, WW_AB, q)
w = CW_AB + β·(WW_AB − CW_AB)

d = attemptAb(w, Y, f)
if d:                                        // DESAT: keep lumens, give up saturation
  lo = 0; hi = 1                             // lo = saturation kept (feasible), hi infeasible
  repeat BISECT_STEPS (10) times:
    mid = 0.5·(lo + hi)
    dm = attemptAb(w + mid·(q − w), Y, f)    // straight line in the a/b plane
    if dm: lo = mid; d = dm   else: hi = mid
  return {d, desat, 1 − lo, lm}              // desat is a multiple of 1/1024

// CLAMP: even white can't reach the lumens → the brightest w it can make
d = zeros; lo = 0; hi = 1
repeat BISECT_STEPS + 2 (12) times:
  mid = 0.5·(lo + hi)
  dm = attemptAb(w, mid·Y, f)
  if dm: lo = mid; d = dm   else: hi = mid
return {d, clamp, 1, lo·lm}                  // lm is a multiple of lm/4096
```

### What the bulb actually makes (`bulbOutput`)
Start with `s = solve(a, b, B·1000, F)`, then:
- If the mode is **off**, the output is `(a, b, 0, F)`.
- If the mode is **exact**, the output is `T` unchanged.
- Otherwise, compute `X = XYZ(s.duty)` (§6). If `X₁ ≤ 0`, the output is `(a, b, 0, F)`.
  Otherwise the output is `(ab(X), X₁·lmPerY/1000, F)`. The caller is told the mode and `s.desat`.

vibes memoizes this result by the key `"a b B F"` and clears the cache past 16384 entries. That cache has no
effect on results. Only BR30 bulbs are solved. 4×1 panels have no model yet and
are taken at their word: the output is T, with mode exact if B > 0 and off otherwise.

---

## 8. vibes-only UI mappings (not part of the canonical Lemtone)

- **Color wheel** (OKLCh at L = 1): the rim is at radius 1, and R_C = 0.96 is just past the blue LED's
  chroma of 0.947. `chromaAt(r) = 0.96·max(0, r)^1.6`, and `radiusOf(C) = (max(0, C)/0.96)^(1/1.6)`.
  `wheelColor(dx, dy)`, with dx to the right and dy up, returns (0, 0) when r = hypot(dx, dy) is 0, and otherwise
  `(dx/r, dy/r)·chromaAt(r)`. `wheelSpot(a, b)` is r = min(1, radiusOf(C)) at the angle h.
- **Brightness slider** (cube-root track, B_MAX = 1): the slider position is `look(min(1, B))`, and
  the brightness at a position is `Math.round(pos³·10000)/10000`.
- **Gamut**: Display P3 when `matchMedia("(color-gamut: p3)")` matches, and sRGB otherwise.

## 9. Wire encoding (partial; not in this repo)

Bulbs receive lemtones in packet `0x07`. The only fact this repo has is one golden
test: a and b go as integer codes `round(a/0.0008) + 1046` and
`round(b/0.0008) + 1424`, so 2700 K encodes as (1139, 1616). This repo does not have the bit widths, the
brightness/fidelity encoding, or the packet layout. Take those from `rc-bulb-firmware`.

---

## 10. Reference values (float64, computed by vibes' implementation)

```
cctToXy(1700)  = [0.5609411935680847, 0.4043036207558298]
cctToXy(2700)  = [0.4593139523446629, 0.41066024937841794]
cctToXy(4000)  = [0.38052828281249995, 0.3767335309611144]
cctToXy(6500)  = [0.3134941075102412, 0.32366253911989207]
cctToXy(10000) = [0.2806980021, 0.2883056294468803]
whiteAB(1700)  = [0.17061146072711297, 0.21261259111371894]
whiteAB(2200)  = [0.1102486184987801, 0.18512665901256314]
whiteAB(2700)  = [0.07431161659727889, 0.1532601809317326]
whiteAB(4000)  = [0.03243432327082551, 0.0802692501451687]
whiteAB(6500)  = [0.008747465771315468, -0.005228163394163797]
whiteAB(10000) = [0.0011810540073826114, -0.06069183122598504]
xyzToOklab([0.95047, 1, 1.08883]) = [0.9999998095202896, -0.000010091754968077904, -0.00008610878004511324]

kelvinOf(whiteAB(2000)) = 2000
kelvinOf(whiteAB(2700)) = 2699.9298018251684
kelvinOf(whiteAB(6500)) = 6500.260010400376
kelvinOf(0.25, 0.05)    = none
kelvinOf(0.08, 0.2, ∞)  = 2334.703025775133
kelvinOf(0, 0, ∞)       = 6354.855109303479      kelvinOf(0, 0) = none

hueChroma(0.1, -0.2) = {hue 296.565051177078, chroma 0.223606797749979}

swatch(whiteAB(2800), srgb)       = [0.9999999999999999, 0.6931894924449788, 0.3772811616937845]
swatch(whiteAB(2800), display-p3) = [0.9999999999999999, 0.7403473039685091, 0.452965172304811]
swatch(0.25, 0.05, srgb)          = [0.9999999999999999, 0.4146696091547902, 0.525947255354215]
swatch(-0.26, 0.16, srgb)         = [0, 0.9999999999999999, 0.3829057697824454]
swatch(-0.26, 0.16, display-p3)   = [0.4236430816111213, 0.9999999999999999, 0.4714767559605791]
lightRgb(whiteAB(2800), srgb)       = [1.8704139242895113, 0.8198977130922528, 0.21977129515865335]
lightRgb(whiteAB(2800), display-p3) = [1.6839848782233175, 0.854808114215988, 0.29142964836777535]
lightRgb(0.25, 0.05, srgb)          = [3.007952553652048, 0.43128760873994043, 0.7184444077492983]

lemtoneCss((whiteAB(2800), B 0.1), srgb)  = "rgb(118 82 45)"
lemtoneCss((0.25, 0.05, B 0.03), display-p3) = "color(display-p3 0.3107 0.1515 0.1783)"
lumensText: 0.8 "800 lm" · 0.025 "25 lm" · 0.0025 "2.5 lm" · 0.00995 "10 lm" · 0.009949 "9.9 lm" · 0 "0 lm" · 1.2345 "1235 lm"
lemtoneCode((whiteAB(2800), 0.8, 1))      = "2800 K · 800 lm · F1.00"
lemtoneCode((0.2, 0, 0.03, 0))            = "0° C0.20 · 30 lm · F0.00"
lemtoneCode((0.1, -0.2, 0.0123, 0.5))     = "297° C0.22 · 12 lm · F0.50"
lemtoneCode((whiteAB(2712), 0.4, 0.333))  = "2700 K · 400 lm · F0.33"

P⁰ (Tᵢ(0.4)) and its a/b:
  r  [1319.585548255517, 564.6340917281815, 0.10437136169029049]   ab [0.46160281268401304, 0.21909529746334025]
  g  [258.39592863842176, 1352.0463661918113, 271.2734198760769]   ab [-0.5174715645953417, 0.20375612738361404]
  b  [1810.4373952748113, 299.5731391264159, 9811.74709827176]     ab [0.05879017554561901, -0.9407083456161034]
  ww [7735.389473414466, 6842.22215218831, 2532.0131687545354]     ab [0.08181293936187284, 0.1398620532527218]
  cw [6896.844672570073, 7325.611865668755, 7854.69557977677]      ab [-0.004392827212789085, 0.0026004993388136096]
Lumens of one channel alone at 0.8: r 48.112068129420564, g 122.42968405799427, b 27.872100169619046,
                                    ww 603.0197030306473, cw 651.0715847824653;  all five at 0.8: 794.6342953312352
XYZ([0.3, 0.2, 0.1, 0.5, 0.4]) = [6683.844778726386, 6295.864264947182, 5128.628620831654]

solve(whiteAB(2700), 400, 1)   = exact  [0.687294286239351, 0.34374926539835027, 0, 0.41358937204234375, 0]
solve(whiteAB(2700), 400, 0.5) = exact  [0.7433549945327047, 0.36903554324397025, 0.0015736125642553528, 0.4042822099287209, 0]
solve(whiteAB(2700), 400, 0)   = exact  [0.7999999999999998, 0.3972454920916404, 0.003354924297501921, 0.39525826668534647, 0]
solve(0, 0, 100, 0.5)          = exact  [0.24007729002158157, 0.23824410137206237, 0.04523676879768642, 0, 0.06208521260529402]
solve(0.2, 0.1, 300, 0)        = desat 0.2744140625, lm 300,
                                 [0.8, 0.003755406890073143, 0.044483433163793974, 0.32820744704070054, 0.005755025640880771]
solve(whiteAB(4000), 2000, 1)  = clamp, desat 1, lm 972.16796875,
                                 [0.5220805116177223, 0.4070160145626227, 0, 0.799926207797769, 0.7434616645497037]
solve(0.1, 0.1, 0, 0.5)        = off
bulbOutput((0.2, 0.1, 0.3, 0))           = desat 0.2744140625, light (0.16754727152395396, 0.11094366308492333, 0.29996806801868076, 0)
bulbOutput((whiteAB(4000), 2.0, 1))      = clamp 1, light (0.04101812539299128, 0.07491305215820283, 0.9706967590680364, 1)

wheelColor(0.5, 0.5) = [0.38988115025099307, 0.38988115025099307]
wheelSpot(0.1, -0.2) = {dx 0.17989686848962977, dy -0.3597937369792605}
```

## 11. Firmware reference vectors (a sample) and acceptance

These come from `rc-bulb-firmware/lemtone/test/lemtone_vectors.h`, which is the float64 reference
solve printed to about 9 significant figures. All 309 are in vibes' `src/shared/bulb.vectors.ts`
(270 exact, 24 desat, 14 clamp, 1 off). Each row is
`a, b, lm, F, mode (0 off 1 exact 2 desat 3 clamp), desat, lm_out, d_r, d_g, d_b, d_ww, d_cw`.
```
0.0369683121, -0.0718060749, 262.656049, 0.0, 1, 0, 262.656049, 0.8, 0.718267513, 0.266027347, 0.0, 0.117795872
0.0747464582, -0.0242230382, 292.463175, 0.5, 1, 0, 292.463175, 0.620849974, 0.179765065, 0.107100087, 0.000917040787, 0.277758538
0.0726966264, 0.0500383116, 298.596657, 1.0, 1, 0, 298.596657, 0.275499132, 0.0, 0.0137887888, 0.154036869, 0.220937831
-0.335790858, 0.116175693, 3.58935028, 1.0, 1, 0, 3.58935028, 0.0, 0.0185800978, 0.000228754989, 0.0, 0.00127908443
0.03, 0.08, 600.0, 1.0, 1, 0, 600.0, 0.454224256, 0.399129073, 0.0, 0.366567735, 0.349505211
0.211579744, -0.274312883, 430.994035, 0.0, 2, 0.360351562, 430.994035, 0.8, 0.0147840297, 0.634424063, 0.0, 0.449109824
0.103273989, -0.392808499, 299.505029, 0.0, 2, 0.270507812, 299.505029, 0.0364661763, 0.145741746, 0.8, 0.0, 0.311268911
0.79, -1.12, 50.0, 0.5, 2, 0.428710938, 50.0, 0.514750727, 0.000146030913, 0.617920581, 0.0, 3.77568309e-05
-0.83, 0.27, 50.0, 0.5, 2, 0.407226562, 50.0, 0.00047321688, 0.340753243, 0.00647081684, 0.0, 0.000126640215
0.0, -1.0, 5.0, 0.0, 2, 0.189453125, 5.0, 4.02520669e-06, 0.0146002589, 0.0931989097, 0.0, 0.0
0.149170182, 0.0394195942, 1259.79537, 0.0, 3, 1.0, 867.647151, 0.8, 0.48966846, 0.016004583, 0.799921538, 0.360056917
-1.00917569e-05, -8.61087964e-05, 3000.0, 1.0, 3, 1.0, 804.199219, 0.662647264, 0.683108963, 0.117304112, 0.00989326035, 0.8
0.2, 0.1, 900.0, 0.0, 3, 1.0, 689.941406, 0.8, 0.350815781, 0.0155358249, 0.79649098, 0.0
-1.00917569e-05, -8.61087964e-05, 0.0, 0.5, 0, 0, 0.0, 0, 0, 0, 0, 0
```
The firmware's own acceptance check (`test_solve_vs_reference`), which vibes
copies, is loose:
- Modes may disagree on at most 1% of vectors, to allow for boundary cases.
- Exact-mode duties must agree within 2e-3.
- Desat/clamp duties must agree within 0.02, or desat within 0.01.

A faithful float64 reimplementation of this spec should do much better. It should match every mode and agree to
about 1e-7, which is the vectors' printed precision.
