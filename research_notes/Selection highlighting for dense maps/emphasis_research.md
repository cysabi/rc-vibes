# Emphasis / Highlighting of Selected Marks on Busy, Brightly and Variably Colored Spatial Displays

Scope note for the report writer: the target scenario is many small marks drawn in arbitrary colors, with the selected ones mixed in among unselected ones, sitting on a bright floor whose color varies (a "lit floor"). No study I found tests exactly this combination. The closest empirical analogs are: Mairena et al.'s HexbinMap and "Infographic" conditions (space-filling or arbitrarily colored spatial backgrounds); Waldner et al.'s 1000 multicolored moving dots; Strobelt et al.'s dense, interleaved text; and Haroz & Whitney's multicolored square arrays. Most findings come from scatterplots or text, not maps, and each section flags how they transfer.

## Q1. Mairena, Gutwin, Cockburn et al.: which emphasis techniques work, and how do background and distractors affect them?

### Takeaway
In the largest controlled comparison (12 effects, 4 crowdsourced studies, ~200 participants), motion-based emphasis (Motion×Distance) and shape/QTON changes were the most reliable. Blur/focus and opacity (dimming the distractors) were the weakest and the most fragile. Size emphasis degraded with clutter and barely worked in space-filling map-like (hexbin) displays. Color emphasis depended strongly on background contrast: on a dark background it was much faster. Adding more kinds of distractors hurt only the emphasis channels that the distractors themselves varied on. Outline/halo/ring emphasis was not tested.

### Cited Findings
- Venue/design: Mairena, Gutwin & Cockburn, "Which emphasis technique to use? Perception of emphasis techniques with varying distractors, backgrounds, and visualization types," *Information Visualization* 21(2), April 2022 (online Sept 2021). There were four studies, each with 50 Amazon Mechanical Turk participants (200 total; 45–48 analyzed per study). Each trial had **one target**. — [Mairena et al. 2022, PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC8841630/)
- The 12 effects: six time-invariant (Color, Size, Blur/Focus, Opacity, Shape, QTONs, i.e. Ware's quantitative texton sequences) and six time-variant (Pulse×Time, Flicker×Time, Motion×Time, Pulse×Size, Flicker×Opacity, Motion×Distance). — [Mairena et al. 2022](https://pmc.ncbi.nlm.nih.gov/articles/PMC8841630/)
- How magnitudes were defined:
  - **Color:** CIELAB / CIEDE2000 difference between target and distractors, ΔE 5 to ΔE 30.
  - **Size:** target at 1.25×–2.5× the distractor size, in perceptual steps, using perceived size = actual^0.86.
  - **Blur:** applied to the *non-emphasized* points, Gaussian radius 0.5–3.0 px.
  - **Opacity:** applied to the *non-emphasized* points, distractor opacity from 0.85 down to 0.1, target fully opaque. Blur and opacity are therefore the "lowlighting" / focus+context conditions.
  - No outline/border/halo effect was included or discussed. — [Mairena et al. 2022](https://pmc.ncbi.nlm.nih.gov/articles/PMC8841630/)
- Study 1 (baseline scatterplot, ~2% screen coverage):
  - Accuracy was highest for Motion×Distance (0.95) and lowest for Focus/Blur (0.74).
  - The fastest searches were QTONs (4599 ms) and Motion×Distance (4990 ms); the slowest was Pulse×Time (8685 ms).
  - Overall accuracy rose from 0.59 at the lowest magnitude to 0.93 at the highest.
  - Search time fell from 8654 ms to 5410 ms.
  - At low magnitude, subjective emphasis ratings were below 2/7 for blur, opacity, flicker×opacity and size. At high magnitude, opacity, motion×distance, QTONs and shape exceeded 5/7. — [Mairena et al. 2022](https://pmc.ncbi.nlm.nih.gov/articles/PMC8841630/)
- Study 2 (distractor density 2%, 40%, 80% coverage):
  - Search time rose significantly from 2% to 40% coverage. 80% did not differ from 40% (p = 0.42).
  - Overall accuracy fell from 85% to 78%. The false-negative rate rose to 27%.
  - Size-based effects were "more affected by clutter than other visual variables" (search time).
  - However, the authors also report no significant Clutter × Effect or Clutter × Magnitude interaction. — [Mairena et al. 2022](https://pmc.ncbi.nlm.nih.gov/articles/PMC8841630/)
- Study 3 (number of distractor types: 1, 2 or 3):
  - Shape emphasis slowed sharply when distractors varied in shape: 5756 ms with one type, 7880 ms with two, 7612 ms with three.
  - The key conclusion: "Increasing the types of distractors only reduced the effectiveness of visual variables that were similar to the distractors."
  - Some effects actually improved as distractor variety increased: Pulse×Size accuracy went from 0.48 to 0.82, and Focus/Blur from 0.14 to 0.52. — [Mairena et al. 2022](https://pmc.ncbi.nlm.nih.gov/articles/PMC8841630/)
- Study 4 (five visualization types: white scatterplot, dark-mode scatterplot, Hexbin, HexbinMap, and an "Infographic", which was a stylized U.S. regional map with "arbitrary colors and shapes"):
  - Color emphasis was much faster in dark mode. At magnitude 1 it took 4842 ms versus 7252 ms on white, which the authors attribute to improved contrast.
  - Hexbin had the lowest accuracy. The Infographic was less accurate than HexbinMap and the scatterplot.
  - Opacity emphasis peaked at only 0.56 accuracy in HexbinMap.
  - Size showed "almost no improvement with increasing magnitude" in Hexbin and HexbinMap.
  - Blur and Flicker were slowest in the hexbin types.
  - Motion×Distance and Motion×Time were consistent across all types.
  - The authors: some effects "were much less visible in Hexbin visualizations (likely because of the space-filling nature of this visualization style)." — [Mairena et al. 2022](https://pmc.ncbi.nlm.nih.gov/articles/PMC8841630/)
- Time-variant versus time-invariant effects:
  - Time-invariant effects were faster overall (6257 vs 7058 ms, p < .001). Constant-duration animated effects (pulse×size, motion×distance, flicker×opacity) beat variable-duration ones.
  - Time-variant effects were relatively faster in visualizations with more complex visual elements. — [Mairena et al. 2022](https://pmc.ncbi.nlm.nih.gov/articles/PMC8841630/)
- A logarithmic model fitted to Study 1 predicted the later studies moderately well: r ≈ 0.68 for time, 0.67 for accuracy and 0.84 for ratings. It failed for Color in dark mode (r = 0.039). In other words, background changes how strong color emphasis is in ways the baseline cannot predict. — [Mairena et al. 2022](https://pmc.ncbi.nlm.nih.gov/articles/PMC8841630/)
- The predecessor baseline study tested color, size and blur/focus at 8 strength levels each. It used gaze tracking, clicks and subjective ratings, then validated on real MASSVIS visualizations. It found significant differences between effect types and levels, and a predictive model correlated highly with the Study 2 values. — Mairena, Dechant, Gutwin & Cockburn, "A Baseline Study of Emphasis Effects in Information Visualization," Graphics Interface 2020 — [GI 2020 proceedings](https://graphicsinterface.org/proceedings/gi2020/gi2020-33/)
- Related: Mairena & Gutwin (GI 2022) studied showing and removing emphasis in a complex scatterplot. Highlighting improved performance during training. Removing or changing the emphasis reduced re-finding performance for only a few target types, because emphasized points can act as "accidental landmarks." — [GI 2022 proceedings](https://graphicsinterface.org/proceedings/gi2022/gi2022-25)

### Inferences
- Study 3's "like interferes with like" result transfers directly to marks drawn in arbitrary colors. A *hue* change used as the selection signal is the analog of shape emphasis among varied shapes: expect it to degrade as mark-color variety grows. Emphasis should use a channel the marks do *not* already vary on, such as motion, luminance contrast, an added contour or texton, or shape.
- The HexbinMap and Infographic conditions are the closest tested analogs to a spatial display with a colorful background. In those conditions opacity-dimming, size and blur were the techniques that broke down. Motion survived.
- Dark mode helping color, plus the model failing there, suggests that on a *bright* varying floor any emphasis relying on chromatic contrast needs a luminance-contrast component as well.
- All trials used a single target. Emphasizing *many* selected marks among many unselected ones is untested here. Their results bound the "find one emphasized mark" case only.

### Gaps
- No outline, ring, halo or casing condition exists in any Mairena et al. study I found.
- No multi-target (selected set) condition.
- The GI 2020 paper's numbers (per-level detection rates for color, size and blur) were not retrievable from the landing page.

## Q2. Hall et al. (2016), "Formalizing Emphasis in Information Visualization": taxonomy and guidance

### Takeaway
FIVE (Framework for Information Visualization Emphasis) treats emphasis as differences in *visual prominence* among three sets of marks: a focus set F, an optional middle set M, and a background set B. It names five general features: the F/M/B sets, time, duplication, degree of continuity, and the interplay of intrinsic and extrinsic emphasis. Its most actionable point for this problem is that the base encoding (here, arbitrary mark colors and a bright varied floor) already creates "intrinsic" prominence differences. These can interfere with the added "extrinsic" highlight, which must be strong and distinct enough to dominate them. FIVE is descriptive. It gives no empirical effect sizes.

### Cited Findings
- Citation: K. Wm. Hall, C. Perin, P. G. Kusalik, C. Gutwin & S. Carpendale, "Formalizing Emphasis in Information Visualization," *Computer Graphics Forum* 35(3):717–737, EuroVis 2016 STAR. doi:10.1111/cgf.12936. — [City Research Online](https://openaccess.city.ac.uk/id/eprint/16709/)
- FIVE uses "visual prominence to link visually and algorithmically diverse emphasis effects." It describes, compares and generates emphasis effects. — [Hall et al. 2016 PDF](https://openaccess.city.ac.uk/id/eprint/16709/1/2016_CGF_five_test.pdf)
- The five general features:
  1. Emphasis divides data points into F, M and B.
  2. Time is a principal factor, so both time-variant and time-invariant methods must be included.
  3. Effects may incorporate duplication.
  4. Degree of continuity is an important freedom. Binary highlighting has an empty M. Lenses and gradual drop-off fill M.
  5. Intrinsic and extrinsic emphasis interact. — [Hall et al. 2016 PDF](https://openaccess.city.ac.uk/id/eprint/16709/1/2016_CGF_five_test.pdf)
- Intrinsic and extrinsic emphasis: "differences in prominence due to the original visual mapping are not always negligible, and can even interfere with emphasis effects." Extrinsic effects are "additional visual variations applied on top of an existing visualization." Only "assuming that the changes in visual prominence stemming from an extrinsic emphasis effect are sufficiently strong (e.g., color highlighting)" can the intrinsic emphasis be treated as negligible. — [Hall et al. 2016 PDF](https://openaccess.city.ac.uk/id/eprint/16709/1/2016_CGF_five_test.pdf)
- The survey covers highlighting by color during brushing and linking, blur (Kosara et al.'s semantic depth of field), transparency, halos (citing Oelke et al. 2011), motion, flicker (Waldner et al. 2014), and magnification, distortion and overview+detail. It frames blur as a *de-emphasis of B* rather than an emphasis of F. — [Hall et al. 2016 PDF](https://openaccess.city.ac.uk/id/eprint/16709/1/2016_CGF_five_test.pdf)
- The authors' stated future directions: underexplored visual variables and time variation; annotations and non-visual modalities; and "empirical studies of visual prominence … relating emphasis techniques to perceptual and cognitive mechanisms." That is, the framework itself contains no empirical guidance. — [Hall et al. 2016 PDF](https://openaccess.city.ac.uk/id/eprint/16709/1/2016_CGF_five_test.pdf)

### Inferences
- FIVE gives two equivalent design levers: raise F, as rings, motion or size do, or lower B, as dimming, blur or desaturation do. What matters is the prominence *difference* against everything else in the scene, including the floor.
- A brightly lit, variably colored floor is a strong intrinsic prominence source. Under FIVE, a highlight that only changes hue risks being "weak and not distinct" relative to that intrinsic variation.

### Gaps
- FIVE gives no recommendation on how many marks can sit in F before emphasis stops working. No quantitative guidance was found in the paper.

## Q3. Robinson (2011) and map highlighting: what works on maps?

### Takeaway
Map and geovisualization highlighting has traditionally used "a dedicated bright and saturated color to outline observations." Robinson argues for alternatives, because color is needed for the thematic data. The one controlled follow-up (Griffin & Robinson 2015, eye tracking) found leader-line highlighting as efficient as color highlighting, and found no difference between red and black highlight color. Cartographic practice adds halos and casings (a contrasting outline) to keep symbols and labels legible over complex basemaps, but this is practitioner guidance, not measured effect sizes.

### Cited Findings
- Robinson, A. C., "Highlighting in Geovisualization," *Cartography and Geographic Information Science* 38(4):373–383, 2011, doi:10.1559/15230406384373.
  - Abstract: highlighting "is typically implemented using a dedicated bright and saturated color to outline observations."
  - The paper presents alternatives drawn from the visual variables and non-visual-variable methods, "such as the use of lines to connect highlighted observations."
  - It proposes design criteria for predicting and testing highlighting methods, and highlighting "types" that combine, modify, or are "driven directly by data values." — [Penn State Pure](https://pure.psu.edu/en/publications/highlighting-in-geovisualization/)
- Griffin, A. L. & Robinson, A. C., "Comparing Color and Leader Line Highlighting Strategies in Coordinated View Geovisualizations," *IEEE TVCG* 21(3):339–349, 2015, doi:10.1109/TVCG.2014.2371858. In an eye-tracking experiment:
  - "participants extract information as efficiently" with leader lines as with color highlighting.
  - "no significant differences" when the highlight color changed from red to black.
  - The authors conclude that leader lines allow "color to be reserved for representing thematic attributes." — [Penn State Pure](https://pure.psu.edu/en/publications/comparing-color-and-leader-line-highlighting-strategies-in-coordi/)
- Cartographic halo practice (practitioner sources, not empirical):
  - "A halo is an outline of text that has a different colour than the text itself. By making the text dark and the halo light (or vice versa), you can ensure that text elements always have enough contrast with their background." — [EU Data Visualisation Guide: text halos](https://data.europa.eu/apps/data-visualisation-guide/text-halos)
  - Line and symbol casings and text masks help legibility on complex backgrounds. A selective "variable depth of mask" can block background symbols while leaving background colors intact. — [Esri ArcUser, "Polishing your halo"](https://www.esri.com/about/newsroom/arcuser/polishing-your-halo)
- Mairena et al.'s HexbinMap and Infographic map conditions are the map-like empirical data: motion was robust; opacity, size and blur were fragile (see Q1). — [Mairena et al. 2022](https://pmc.ncbi.nlm.nih.gov/articles/PMC8841630/)

### Inferences
- Griffin & Robinson's red-versus-black null result suggests that what matters for map highlighting is a *reserved, consistent* highlight channel, not a particular hue. Black, a luminance extreme, worked as well as saturated red.
- On a map whose marks already use arbitrary colors, Robinson's argument for reserving color for data applies directly. The selection should be signaled by geometry or luminance (ring, casing, leader, motion), not by recoloring marks.

### Gaps
- I could not access Robinson's (2011) full design criteria list and highlighting-type taxonomy beyond the abstract. The paywalled journal and the PSU page give only the abstract.
- Griffin & Robinson's effect sizes and fixation metrics were not retrievable from the abstract page.
- No empirical study was found that quantifies halo or casing benefit for *point symbols* on varied map backgrounds.

## Q4. Healey & Enns, Ware: preattentive features, conjunction limits, and outlines vs fills vs size when targets are interleaved with similar distractors

### Takeaway
A selected mark pops out only if it carries a feature value that no unselected mark shares. Search efficiency falls continuously as targets come to resemble non-targets and as non-targets become heterogeneous (Duncan & Humphreys' similarity theory). That is exactly the problem with recoloring marks that already use arbitrary colors on a varied background. Luminance dominates hue, and hue dominates form. Motion and flicker sit in separate feature maps, and motion can make conjunction targets easy. Closure, size and added line terminators (textons) are listed preattentive features, which is the basis for rings and QTON-like additions. Knowing the target's appearance in advance makes search robust to color variety, while "find the odd one" search is not.

### Cited Findings
- Healey's preattentive features list includes: orientation, length, width, **closure**, **size**, curvature, density, contrast, colour (hue), **intensity**, intersection, **terminators**, 3D depth cues, **flicker**, direction of motion, and velocity of motion. "Tasks that can be performed on large multi-element displays in less than 200 to 250 milliseconds" count as preattentive. — [Healey, Perception in Visualization](https://www.csc2.ncsu.edu/faculty/healey/PP/)
- Conjunction limit: "A target made up of a combination of non-unique features (a conjunction target) normally cannot be detected preattentively." This can be overcome when a "significant target–nontarget feature difference" lets individual feature maps ignore the nontargets. — [Healey](https://www.csc2.ncsu.edu/faculty/healey/PP/)
- Similarity theory (Duncan & Humphreys): search efficiency depends on target–nontarget (T-N) similarity and nontarget–nontarget (N-N) similarity, and both affect performance continuously. — [Healey](https://www.csc2.ncsu.edu/faculty/healey/PP/)
- Feature hierarchy: color interferes with seeing shape patterns, but random shape variation does not interfere with color patterns (a "hue-on-form" hierarchy). There is also a "luminance-on-hue preference." Hence "the most important data attributes should be displayed with the most salient visual features." — [Healey](https://www.csc2.ncsu.edu/faculty/healey/PP/)
- Motion and flicker:
  - Flicker frequency differences of 2–5% are distinguishable at the center of focus, but 100% or more is needed in the periphery.
  - Coherent motion lets otherwise hard conjunction targets become "immediately visible" (e.g., red elements moving up, blue moving down). — [Healey](https://www.csc2.ncsu.edu/faculty/healey/PP/)
- Boolean map theory (Huang et al.): the visual system divides a scene into "exactly two parts: selected elements and excluded elements." Successive Boolean map operations can perform conjunction searches in constant time. — [Healey](https://www.csc2.ncsu.edu/faculty/healey/PP/)
- Change blindness: "an interruption in what is being seen (e.g., a blink, an eye saccade, or a blank screen) renders us 'blind' to significant changes" during the interruption. — [Healey](https://www.csc2.ncsu.edu/faculty/healey/PP/)
- Healey & Enns' review is "Attention and Visual Memory in Visualization and Computer Graphics," *IEEE TVCG* 18(7):1170–1188, 2012. I cite it bibliographically only, from a reference list. — [Quadri & Rosen survey, arXiv 2107.07477](https://arxiv.org/pdf/2107.07477)
- Haroz & Whitney, "How Capacity Limits of Attention Influence Information Visualization Effectiveness," *IEEE TVCG* 18(12), InfoVis 2012. The displays were arrays of colored squares with 1–7 colors (or 1–5 motion directions), in grouped or random layouts, with 5 subjects × 960 trials per experiment:
  - **Known-target search** ("find the red one"): accuracy above 95% in all blocks, with "almost no impact" of feature variety.
  - **Oddball search** (unknown unique item): accuracy "significantly affected by the amount of variety." Random layouts showed "a marked decline as variation increased," while grouped layouts showed little degradation.
  - Color gave faster responses than motion in both tasks.
  - *Local* variety next to the target had no measurable effect. *Global* variety on screen did.
  - Conclusions: "(1) Grouping is far more beneficial for oddball search… (3) For difficult tasks, aim to reduce variety in the entire view rather than optimizing small regions." — [Haroz & Whitney 2012 PDF](https://whitneylab.berkeley.edu/PDFs/Haroz_Whitney_2012_InfoVis.pdf)
- Peripheral popout: Gutwin, Cockburn & Coveney, "Peripheral Popout: The Influence of Visual Angle and Stimulus Intensity on Popout Effects," CHI 2017, pp. 208–219, doi:10.1145/3025453.3025984. They tested color, shape, size, motion, luminance and flashing at five intensities across a wide range of visual angles.
  - "Motion is a strong popout stimulus, even at low intensities and wide angles." Identification accuracy "decreases rapidly across visual angle" for the other variables, "particularly with shape and color." — [ACM DOI / abstract via search](https://doi.org/10.1145/3025453.3025984)
  - Survey summary: shape "required high effort with a low performance, whereas motion showed little effort and a high level of performance." The other four channels increased in visibility and accuracy with intensity. — [Quadri & Rosen survey](https://arxiv.org/pdf/2107.07477)
- Ware's surround-color advice, as applied by Oelke et al.: "Size is an efficient and intuitive way to enhance the visibility … However, in most cases we do not want to change the layout … We therefore follow Colin Ware's suggestion of adding a surround color" (citing Ware, *Visual Thinking for Design*, 2008). Also: "the more heterogeneously colored the visualization is, the larger the perceptual distance of the boosting color has to be." — [Oelke et al. 2011 PDF](https://bib.dbvis.de/uploadedFiles/320.pdf)
- Why a border or ring works (text analog): in Strobelt et al.'s study a rectangular border ranked second of nine text highlights. The authors hypothesize that "the box might make the target appear bigger … the task becomes detecting something bigger than normal." They also note color's strong pop-out holds "if the background does not vary with respect to color." — [Strobelt et al. 2016 paper](https://vcg.seas.harvard.edu/publications/20160101-guidelines-for-effective-usage-of-text-highlighting-techniques/paper)

### Inferences
- **Outline/ring.** A ring adds a closed contour and extra luminance edges. Closure, terminators and intensity are listed preattentive features, and a ring also enlarges the mark's apparent footprint, a size cue. It pops out only if no unselected mark or floor feature has a similar ring. A thin ring of a single color is likely to vanish wherever the floor's luminance matches the ring's (see Waldner's halo and Doerr's outline results in Q5 and Q6).
- **Fill/hue change.** With marks in arbitrary colors, N-N similarity is low and the selected hue will often be close to some unselected marks or floor regions. Similarity theory predicts slow, serial search. Healey's luminance-on-hue hierarchy suggests luminance contrast, as in a dark-plus-light casing, is the stronger lever.
- **Size.** Size is preattentive but relative. With many interleaved marks of varying apparent size, and with Mairena's clutter and hexbin results, a size boost alone is unreliable. It also increases overlap.
- **Known target versus oddball.** If the selection marker always looks the same (a learned, consistent "selected" glyph), the user is doing known-target search, which Haroz & Whitney found robust to color variety. A uniform treatment across all selected marks also lets the viewer form a single Boolean map of "selected," per Huang et al. Both argue for one consistent, reserved selection style rather than per-item colors.
- **Motion.** Motion is the one channel that survives clutter, distractor variety, map backgrounds and peripheral viewing (Mairena, Gutwin, Healey). The open question is annoyance (Q5).

### Gaps
- I did not obtain the text of Ware's *Information Visualization: Perception for Design* (Morgan Kaufmann, 3rd/4th eds.). I could not verify the exact wording of his guidelines on borders or outlines for symbols on varied backgrounds, beyond Oelke et al.'s citation of his surround-color suggestion.
- Munzner's *Visualization Analysis & Design* (2014) was not consulted directly in this session. Its popout and "separability" discussion is not cited here.
- Gutwin et al.'s per-variable accuracy numbers by visual angle were not retrievable (paywalled).

## Q5. Dimming non-selected items vs marking selected ones; halos and casings over varied backgrounds; how many items can be tracked

### Takeaway
Dimming the context ("lowlighting": opacity or blur on non-selected items) was among the weakest emphasis types in controlled tests. It collapsed on space-filling, map-like displays: opacity reached at most 0.56 accuracy in HexbinMap, and blur had the lowest baseline accuracy (0.74). Greying out context also destroys category information. However, dimming *combined with* a bright ring around the target ("spotlight") was one of the two best techniques in a cluttered multicolor scene. A plain ring alone was the most often missed. Halos and surrounds are recommended for small marks in heterogeneous displays, with notes on saturation, transparency and draw order, but evidence is mostly design-analytic. For tracking moving items, attention handles roughly 4 objects, up to about 8 if slow. This argues for a persistent visual marker rather than relying on the user to remember which items are selected.

### Cited Findings
- Dimming and blur results (Mairena et al. 2022):
  - Opacity (non-selected faded to 0.85–0.1) and blur (0.5–3 px on non-selected) both rated below 2/7 at low magnitudes.
  - Blur had the lowest baseline accuracy (0.74).
  - Opacity peaked at 0.56 accuracy in HexbinMap.
  - Blur and flicker were slowest in hexbin displays. — [Mairena et al. 2022](https://pmc.ncbi.nlm.nih.gov/articles/PMC8841630/)
- Contrary evidence on blur: Kosara, Miksch & Hauser's semantic depth of field (SDOF) user study reported that SDOF "is a preattentive feature, i.e., can be perceived within 200 ms," is "not significantly slower than color when used in search tasks," and "does not decrease performance when combined with another feature." This was in their own stimuli; the blur strength likely differed from Mairena's 0.5–3 px. — [Kosara et al., IEEE CG&A 2002, eagereyes](https://eagereyes.org/publications/Kosara-CGA-2002)
- Waldner et al., "Attractive Flicker: Guiding Attention in Dynamic Narrative Visualizations," *IEEE TVCG* 20(12):2456–2465, 2014 (VIS 2014). Comparative pilot:
  - Setup: N = 10, a dual task, 1000 *colored*, randomly moving dots on three 27″ monitors spanning ~180° (7680×1440 px).
  - Techniques:
    - **Flicker:** full-range L* 0–100 luminance flicker.
    - **Spotlight:** a bright ring (L* 50, twice the dot radius) plus context luminance reduced by 75%, following Khan et al.
    - **Halo:** the same ring without context darkening.
  - Results: "a simple halo around the target was more likely to be missed than a flickering target or a bright halo in a dark scene, and also led to the slowest reaction times." "All users stated that halo was the hardest technique." Flicker equalled spotlight's success rate but had slower reaction times.
  - Some users found spotlight's darkening "too obtrusive" ("It is slightly irritating, because it covers the other things"). — [Waldner et al. 2014 PDF](https://vis.cs.ucdavis.edu/vis2014papers/TVCG/papers/2456_20tvcg12-waldner-2346352.pdf)
- Waldner et al., flicker parameter studies:
  - Study 1: N = 10, a 2 × 5 × 5 design. Amplitudes were 25–100 L* units and durations 250–2000 ms.
  - "Even in the (para)foveal region, only scene elements flickering with the highest possible luminance amplitude of A = 100 could reliably attract the visual attention of the observer within 500 milliseconds in our complex scene."
  - "Small targets in the periphery cannot fully reliably attract the user's attention with luminance flickering alone."
  - Annoyance "increases with linearly increasing amplitude and logarithmically decreasing period." The cost–benefit optimum was a period of 400–800 ms with amplitude 17–29.
  - Recommended two-stage signal: an orientation burst no longer than 500 ms (example parameters Ao = 100, To = 50 ms, do = 500 ms), then decay to an engagement stage with "an amplitude covering one quarter of the luminance range and a frequency below 2 Hz."
  - In the showcase study, no user reported the engagement flicker as disturbing when observing context. — [Waldner et al. 2014 PDF](https://vis.cs.ucdavis.edu/vis2014papers/TVCG/papers/2456_20tvcg12-waldner-2346352.pdf)
- Earlier attractor findings cited by Waldner:
  - Bartram et al. found slowly moving icons the least disturbing but also least effective motion cue.
  - Gluck et al. found an icon following the cursor more effective but more annoying than a 3 Hz blinking icon.
  - The paper notes "a trade-off between effectiveness of an attractor and its perceived annoyance." — [Waldner et al. 2014 PDF](https://vis.cs.ucdavis.edu/vis2014papers/TVCG/papers/2456_20tvcg12-waldner-2346352.pdf)
- Oelke, Janetzko, Simon, Neuhaus & Keim, "Visual Boosting in Pixel-based Visualizations," *CGF* 30(3):871–880, EuroVis 2011. Halos and surrounds for single small marks in dense, heterogeneously colored displays:
  - Halos: "it is best to use a less saturated or semi-transparent color." Transparency keeps overlapping halos visible "but may lead to blended colors that are difficult to interpret." It is "advantageous not to overpaint pixels representing a value." When halos overlap, "the painting order is important … the last color will be the most salient one."
  - Halos, glyphs and background coloring "use the space around the pixel," so they degrade in dense data.
  - Animation/blinking "certainly has a high effectiveness," but they "downrate" it because "many people feel annoyed if too much of a scene is blinking." Blinking also affects color perception when the background shows through.
  - Caveat: their comparison is a theoretical, literature-based assessment. "Such a large [user] study is clearly beyond the scope of this paper." — [Oelke et al. 2011 PDF](https://bib.dbvis.de/uploadedFiles/320.pdf)
- Context loss with grey-out: "A canonical strategy for highlighting selected points is to dim colors for non-selected data by assigning a neutral grey … it results in a loss of context. While modulating lightness or opacity for non-selected data items can alleviate this issue, it can lead to poor class separability." Lu, Reda, Deussen & Wang (CHI 2023) instead swap between two class-consistent palettes, one with large and one with small contrast to the background, so selected classes pop out while all classes remain separable and keep their color names. Effectiveness was shown via crowdsourced experiments; numbers were not retrieved. — [Lu et al. 2023, arXiv](https://arxiv.org/abs/2302.05368)
- Tracking capacity: early work put the multiple-object-tracking limit at about four objects (Pylyshyn & Storm 1988). Alvarez & Franconeri (2007) showed a speed–capacity trade-off: up to eight slow objects, but only one fast one. — [Alvarez & Franconeri 2007 PDF](https://visualcognition.psych.northwestern.edu/publications/AlvarezTracking2007.pdf)

### Inferences
- **Lowlighting alone is a poor fit for a bright, varied floor.** Fading unselected marks toward transparency lets the bright floor show through. Prominence then becomes "selected mark versus floor," which is exactly where the floor's variability bites; this matches the HexbinMap failure. Darkening the *whole* context, floor included, as spotlight does, works but is obtrusive and kills context.
- **Ring plus local contrast beats ring alone.** Waldner's halo failed because a mid-luminance ring has no guaranteed contrast against a multicolor scene. A two-tone casing (dark outer stroke plus light inner stroke, or the reverse) guarantees a luminance edge against any background, which is the cartographic halo logic. This is an inference from the combined evidence, not a measured result for point marks.
- **Motion and flicker for attention, static marker for persistence.** Waldner's two-stage model maps directly onto selection. A brief strong transient (≤500 ms) on selection or change shows *where* the selection landed. A subtle persistent cue, or a static ring, then keeps the set identifiable without annoyance. Change blindness (Healey) implies a selection change made during a saccade or redraw can be missed without a transient.
- **Selected-set size.** Users cannot hold more than about 4–8 changing items in attention. Selections larger than that need a persistent, uniformly styled marker that the user can re-find by known-target search, not memory.
- **Draw order.** Draw selected marks and their halos last (on top), and do not let halos overpaint other marks' fills, per Oelke.

### Gaps
- No controlled study was found that compares "dim unselected" versus "mark selected" for *multiple* selected targets among many, on a bright background.
- No empirical effect sizes were found for two-tone (dark plus light) casings around point symbols. Evidence is practitioner guidance for text and line casings plus the halo failure in Waldner.
- Lu et al.'s (2023) quantitative crowdsourced results were not retrievable (the PDF host returned 404, and the arXiv abstract has no numbers).

## Q6. Highlighting in scatterplots and dense point/text displays with quantified results (incl. Strobelt et al. as analog)

### Takeaway
In dense, interleaved text (the closest analog to many small marks packed together), increasing size and adding a border or box were the strongest single highlights. Background fill and red text came next, and italics and letter spacing were weakest. In Strobelt et al.'s distractor study, size and border lost their significant lead over background fill and red text once a second highlight type was present. Their best combinations pair techniques on different channels (border + red, font size + yellow background). In an AR/VR situated study (Doerr et al.), a solid color fill beat outlines, which were "hard to perceive" when small or low in contrast. Color discrimination itself needs much larger ΔE for small point marks, and more still among distractor points (Szafir).

### Cited Findings
- Strobelt, Oelke, Kwon, Schreck & Pfister, "Guidelines for Effective Usage of Text Highlighting Techniques," *IEEE TVCG* 22(1), 2016 (VIS 2015). Three Mechanical Turk studies. — [Harvard VCG page](https://vcg.seas.harvard.edu/publications/20160101-guidelines-for-effective-usage-of-text-highlighting-techniques); [paper PDF](https://vcg.seas.harvard.edu/publications/20160101-guidelines-for-effective-usage-of-text-highlighting-techniques/paper); [talk slides](https://www.cs.ubc.ca/~tmm/courses/547-15/slides/jordon-texthilight.pdf)
  - **Study 1** (ranking; 63 recruited, 45 analyzed; 673 words with 20 highlighted; find as many as possible within a time limit):
    - The top four were "font size, border, yellow background, red text." The lowest were letter spacing and italics, which was "significantly lower than the rest."
    - The authors explain the border's strength as making the target "appear bigger." Color pops out "if the background does not vary with respect to color." Background fill may beat text color "because the colored area is much larger."
  - **Study 2** (interference; 30 analyzed; 72 trials; find words with A only, among A, B and A+B):
    - Highlighting technique had a significant effect, F(8, 2114) = 236.61, p < .0001, and so did the distractor technique, F(8, 2114) = 65.60, p < .0001.
    - All techniques except italics lost performance. Underline lost least (−12%).
    - Font size and border "were no longer significantly higher than yellow background and red text."
    - The paper invokes Ware's rule "like interferes with like."
  - **Study 3** (conjunction search; 24 participants; 36 trials).
  - Guidelines:
    - A single feature: use font size, border or yellow background.
    - Two features of equal visibility: bold + yellow background, border + red, font size + yellow background, font size + border.
    - Conjunction most important: border + red, font size + red, font size + yellow background.
    - One feature dominant: pair a strong technique with a weak one, e.g. border + italic.
- Doerr, Lee, Baricova, Schmalstieg & Sedlmair, "Visual Highlighting for Situated Brushing and Linking," *CGF* 43(3), EuroVis 2024. N = 20, within-subjects, 4 techniques × 2 layouts × 3 tasks.
  - The techniques were Color (solid yellow), Outline, Link and Arrow.
  - Color was best on errors and tied best on time. Link tied on time and preference and excelled for out-of-view targets. Outline came third. Arrow was worst.
  - Outline was "most subtle and least obstructive," but participants reported "hardness in perception" due to small size and insufficient contrast at some product boundaries.
  - The authors excluded blur (semantic depth of field) as "visually distracting." — [Doerr et al. 2024, arXiv](https://arxiv.org/html/2403.15321v3)
- Szafir, "Modeling Color Difference for Visualization Design," *IEEE TVCG* 24(1), 2018 (VIS 2017). Perceived color difference "varies inversely with size," and elongated marks give significantly greater discriminability. — [project page](https://cmci.colorado.edu/visualab/VisColors/)
- Szafir's talk slides add, for the scatterplot-point experiment (81 MTurk participants, 5,668 trials, point diameters ~0.5–2.0° visual angle):
  - Required differences for "diagonally symmetric points" were "7x larger than existing models."
  - They "vary inversely with size," replicating Stone et al. 2014.
  - They are "increased by distractor points." — [Szafir VIS 2017 slides](https://cmci.colorado.edu/visualab/VisColors/17-VIS-ModelingColorDifference.pdf)
- Bartram & Ware, "Filtering and Brushing with Motion" (2002):
  - Motion "can effectively group objects that are otherwise dissimilar."
  - Differentiating by *type* of motion (linear, circular, expansion/contraction) is more effective than by direction, unless directions are 90° apart.
  - Circular motion "demands the most attention."
  - Venue conflict: the search summary listed it as ACM TAP vol. 1 pp. 66–79. My understanding is that it appeared in *Information Visualization* 1(1):66–79, 2002; verify before citing. — [UNH Scholars](https://scholars.unh.edu/ccom/978)
- Oelke et al. 2011: for pixel-based (dense) displays, recoloring important pixels with "a color that has a high perceptual contrast" works. One way is "to use a black and white colormap and color important pixels with another color (e.g., red or yellow)," because heterogeneous coloring requires a larger perceptual distance. — [Oelke et al. 2011 PDF](https://bib.dbvis.de/uploadedFiles/320.pdf)

### Inferences
- Transfer from text to points: text is dense, regularly spaced and already uses channels such as letter shape and spacing. Strobelt's "pop-out requires a channel the base content doesn't already use" maps onto "marks already use arbitrary hue, so don't use hue for selection." The border result suggests a ring *can* be strong when it substantially enlarges the mark's footprint, which a thin outline does not do.
- Strobelt and Doerr together suggest a *filled or large* contrast area beats a *thin* contour. For small point marks, a ring needs width comparable to the mark's radius, as Waldner/Khan's spotlight ring at twice the dot radius did. Its luminance must contrast with both the mark and the floor; a dual-stroke casing does this.
- Szafir's inverse-size result means small marks need a large color step to be seen as "different" at all. Recoloring tiny selected marks is the least reliable option on a busy display. Adding geometry (a ring or casing that increases size) also increases the area available for any color signal.
- Candidate recipe consistent with all the evidence (inference, not tested as a package):
  - a reserved two-tone casing or ring around each selected mark, drawn on top;
  - optionally a modest size increase;
  - optionally mild, class-preserving de-emphasis of unselected marks (lowered lightness or contrast rather than grey-out or transparency over a bright floor);
  - a brief motion or flicker transient (≤500 ms) when the selection changes, decaying to static or a subtle oscillation (<2 Hz, ~25% luminance amplitude).

### Gaps
- No scatterplot study was found that quantifies *ring/outline* emphasis against fill, size and dimming for multiple targets. Doerr et al. is the only direct outline-versus-color comparison, and it is in VR with physical objects.
- Szafir's numeric ΔE thresholds per point size were only partly recoverable from the slides. The TVCG paper itself (`par.nsf.gov` copy) was not read.
- No study was found on highlighting legibility over a *bright, chromatically varying, emissive* background, like a lit LED floor. All evidence is from monitors with white, black or rendered-map backgrounds.
