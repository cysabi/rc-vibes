# Selection rendering conventions in design/canvas tools and web maps/GIS (for multi-selecting many small, densely packed items)

Scope note: research done 2026-10-17. Primary sources were the open-source code of tldraw (main branch) and Excalidraw (master branch), the official docs for Figma, ArcGIS Maps SDK for JS (v4.32+ typings on npm), ArcGIS Pro SDK, Mapbox, QGIS (PyQGIS), Apple MapKit and Leaflet.markercluster, plus WCAG 2.2 Understanding docs. Closed-source tools (Figma, Illustrator, Sketch, Miro, FigJam, Google Maps, Apple Maps) publish few or no pixel-level specs. The Gaps sections list what could not be verified.

---

## Q1. Design and whiteboard canvas tools: how they draw selected, multi-selected and hovered objects, keep outlines legible, and handle selecting many tiny objects

### Takeaway
The convention is a thin (1 to 1.5 screen px), saturated mid-blue or violet outline drawn **on every selected object**. Its width is divided by zoom so it stays a constant screen width. When more than one object is selected, one extra **common bounding box** with handles surrounds the whole selection (Excalidraw draws it dashed). Hover uses the same outline as selection, shown for one object at a time. A thicker stroke is kept for "hinted" or drop-target states. None of the tools inspected dims unselected objects. For many tiny objects they rely on marquee/brush (intersect or contain), lasso/scribble, and "select matching / same properties" commands, and they shrink or hide handles when the selection is tiny.

### Cited Findings

**tldraw (open source, verified in code)**
- The selection stroke color is `hsl(214, 84%, 56%)` in both light and dark themes. The selection fill (used for brush/marquee and handle backgrounds) is `hsl(210, 100%, 56%, 24%)` in light and `hsl(209, 100%, 57%, 20%)` in dark. — [tldraw defaultThemes.ts](https://github.com/tldraw/tldraw/blob/main/packages/editor/src/lib/editor/managers/ThemeManager/defaultThemes.ts); the same values are CSS vars `--tl-color-selection-stroke` / `--tl-color-selection-fill` in [tldraw editor.css](https://github.com/tldraw/tldraw/blob/main/packages/editor/editor.css)
- Every selected shape gets its own outline, called a "shape indicator": `ShapeIndicatorOverlayUtil` loops over `editor.getSelectedShapeIds()` and strokes each shape's outline with `selectionStroke` at `lineWidth: 1.5 / zoom`. All indicators are batched into a single canvas stroke call. — [tldraw ShapeIndicatorOverlayUtil.ts](https://github.com/tldraw/tldraw/blob/main/packages/tldraw/src/lib/overlays/ShapeIndicatorOverlayUtil.ts), [strokeShapeIndicators.ts](https://github.com/tldraw/tldraw/blob/main/packages/editor/src/lib/editor/overlays/strokeShapeIndicators.ts)
- **Hover vs selected in tldraw:** the hovered shape is added to the same indicator list, so it gets the same color and the same 1.5px width. This happens only when idle, the pointer is over the canvas, and the pointer is **not coarse** (no hover indicators on touch). "Hinted" shapes, such as drop or bind targets, are stroked thicker at `hintedLineWidth: 2 / zoom`. — [tldraw ShapeIndicatorOverlayUtil.ts](https://github.com/tldraw/tldraw/blob/main/packages/tldraw/src/lib/overlays/ShapeIndicatorOverlayUtil.ts)
- The CSS indicator class uses `stroke-width: calc(1.5px * var(--tl-scale))` and `fill: none`. — [tldraw editor.css](https://github.com/tldraw/tldraw/blob/main/packages/editor/editor.css)
- The selection bounding box (one rectangle around the whole selection) is stroked with `strokeRect` in the selection color at `lineWidth 1.5 / zoom`. Resize handles are squares of `handleSize = 8 / zoom` (8 screen px), filled with the background color and stroked in the selection color. — [tldraw SelectionForegroundOverlayUtil.ts](https://github.com/tldraw/tldraw/blob/main/packages/tldraw/src/lib/overlays/SelectionForegroundOverlayUtil.ts)
- **Tiny-selection logic in tldraw:**
  - `isTinyX = width < handleSize*2` (under 16 screen px) and `isSmallX = width < handleSize*4` (under 32 px).
  - If tiny on either axis, the alternate corner handles are hidden (only top-left and bottom-right remain) and the corner rotate handles are hidden.
  - If tiny on both axes, only one handle is shown.
  - Hit targets are `6/zoom` px, halved for small selections, and multiplied by 1.75 on coarse pointers.
  — [tldraw SelectionForegroundOverlayUtil.ts](https://github.com/tldraw/tldraw/blob/main/packages/tldraw/src/lib/overlays/SelectionForegroundOverlayUtil.ts)
- **Marquee/lasso in tldraw:**
  - By default the brush selects shapes it **intersects**.
  - "Wrap mode", a user preference, requires full enclosure. Holding the accel key (Cmd/Ctrl) inverts the current mode.
  - Holding Alt while brushing switches to `scribble_brushing`, a freehand lasso-like scribble that selects whatever shapes the scribble line crosses.
  — [tldraw Brushing.ts](https://github.com/tldraw/tldraw/blob/main/packages/tldraw/src/lib/tools/SelectTool/childStates/Brushing.ts), [ScribbleBrushing.ts](https://github.com/tldraw/tldraw/blob/main/packages/tldraw/src/lib/tools/SelectTool/childStates/ScribbleBrushing.ts)

**Excalidraw (open source, verified in code)**
- The selection color comes from the CSS var `--color-selection`: `#6965db` (violet) in light theme and `#b4b0ff` in dark theme. — [Excalidraw theme.scss](https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/css/theme.scss), [renderer/helpers.ts getSelectionColor](https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/renderer/helpers.ts)
- **Per-element border:** each locally selected element gets its own rectangle border.
  - Width is `1 / zoom` (constant 1 screen px), and 4px for an active embeddable.
  - Padding is `DEFAULT_TRANSFORM_HANDLE_SPACING * 2 / zoom` = 4 screen px (`DEFAULT_TRANSFORM_HANDLE_SPACING = 2`).
  — [Excalidraw interactiveScene.ts](https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/renderer/interactiveScene.ts), [constants.ts](https://github.com/excalidraw/excalidraw/blob/master/packages/common/src/constants.ts)
- **Multi-selection in Excalidraw** = per-element borders **plus** a common bounding box drawn with `getCommonBounds(selectedElements)`.
  - The box is **dashed** (`setLineDash([2 / zoom])`), 1/zoom px wide, in the selection color, padded 4 screen px.
  - Transform handles sit on the common box only.
  — [Excalidraw interactiveScene.ts](https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/renderer/interactiveScene.ts)
- **Groups and locks in Excalidraw:**
  - A selected group's elements do not get individual borders (`!isSelectedViaGroup`). Instead the group gets one **dashed** box in `groupSelectionColor` (`#000`, theme-adjusted).
  - Locked elements get a dashed border in `#ced4da` (light gray).
  — [Excalidraw interactiveScene.ts](https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/renderer/interactiveScene.ts)
- **Multiplayer selections in Excalidraw:** when several users select the same element, the border is drawn as **interleaved dashes**, one dash per user color (dash 8/zoom, gap 4/zoom, offset per user). Remote selections are always dashed, which visually separates "mine" (solid) from "theirs" (dashed). — [Excalidraw interactiveScene.ts renderSelectionBorder](https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/renderer/interactiveScene.ts)
- "Elements to highlight" (e.g. search results or frame children) use a separate box highlight in `rgb(0,118,255)`, optionally dashed. — [Excalidraw interactiveScene.ts renderElementsBoxHighlight](https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/renderer/interactiveScene.ts)
- Excalidraw box selection defaults to `boxSelectionMode = "contain"` (the element must be fully inside the box), with an `"overlap"` alternative. — [Excalidraw element/selection.ts](https://github.com/excalidraw/excalidraw/blob/master/packages/element/src/selection.ts)

**Figma (official help center)**
- When multiple objects are selected, "a blue box will appear around each object [in] the selection", meaning a per-object outline. — [Figma Help: Select layers and objects](https://help.figma.com/hc/en-us/articles/360040449873-Select-layers-and-objects)
- Hovering a layer in the Layers panel shows "a blue box [highlighting] that layer's location on the canvas". View-only collaborators' selections appear as "a solid purple box", with "a dashed purple box" for the parent object. — [Figma Help: Select layers and objects](https://help.figma.com/hc/en-us/articles/360040449873-Select-layers-and-objects)
- **Figma's commands for building large selections:**
  - Marquee: drag from empty canvas.
  - Shift-click to add or remove.
  - Cmd/Ctrl for deep select, which also works with the marquee for nested objects.
  - Enter / Shift+Enter / Tab to move to child, parent and sibling.
  - "Select matching layers" (⌥⌘A / Alt+Ctrl+A).
  - Edit → "Select all with same" Properties / Fill / Stroke / Effect / Text / Font / Instance.
  - Select inverse.
  — [Figma Help: Select layers and objects](https://help.figma.com/hc/en-us/articles/360040449873-Select-layers-and-objects)
- The help-page summary states the marquee "doesn't require full containment" (objects are selected as the marquee passes over them). Treat this as a summarizer reading of the page, not a quoted spec. — [Figma Help: Select layers and objects](https://help.figma.com/hc/en-us/articles/360040449873-Select-layers-and-objects)
- Figma's UI blue is reported as `#0D99FF` (used for selection and focus) only by **low-quality third-party** design-system gallery pages, not by Figma docs. — [oppadu design-system gallery](https://www.oppadu.com/tools/design-systems-site/brand/figma.html), [Elysia Tools Figma samples](https://elysiatools.com/fr/samples/figma-samples) (low confidence)

**Illustrator**
- Illustrator exposes Preferences → Selection & Anchor Display. It has controls to resize anchor points, handles and bounding boxes, "Highlight anchors on mouse over", a handle style choice (solid blue vs white circles), and "Show handles when multiple anchors are selected". — [Adobe Help: Adjust anchor point, handle, and bounding box display size](https://helpx.adobe.com/bg/illustrator/desktop/draw-shapes-and-paths/learn-drawing-basics/adjust-anchor-point-handle-and-bounding-box-display-size.html)
- Users report Illustrator selection chrome (artboard edges, anchors, bounding box) appearing "grey and barely visible", which is a legibility failure mode. — [Adobe Community thread](https://community.adobe.com/t5/illustrator-discussions/artboard-edges-anchor-points-and-bounding-box-are-grey-and-barely-visible/m-p/14125994/highlight/true)

**Cross-tool hover/hit areas**
- tldraw's survey of 16 design tools found that "every app I tried seemed to do things in a slightly different way" for handle hover areas. Figma uses larger edge hit areas with a circular corner region. Sketch uses "a similar wrapping corner radius" with a slightly larger corner area. Miro was described as "in a poor state", with a corner area smaller than its edges and edges that overlap. Excalidraw and Canva use equal corner and edge sizes. Method: the author moved the mouse over a 50×50 grid and recorded the cursor at each point. — [tldraw blog: An exhaustive review of design tool hover areas](https://tldraw.dev/blog/a-review-of-design-tool-hover-areas)

### Inferences
- **Constant screen-space width is universal.** tldraw (1.5/zoom), Excalidraw (1/zoom), handle sizes (8/zoom) and paddings (4/zoom) are all divided by zoom. Outlines and handles never scale with the artwork. For a floor plan with ~110 fixtures, selection rings should be specified in CSS/screen px, not plan units.
- **Per-item outline is the primary signal, and the group bounding box is secondary.** It exists mainly to carry transform handles. A light-fixture app that does not transform groups can drop the group box, or render it faint or dashed in the Excalidraw style, without breaking convention.
- **Hover and selected share styling in tldraw.** Hover is shown on only one item at a time and not on touch. Excalidraw and Figma separate them less clearly. Using a lighter or thinner variant for hover, distinct from selected, is consistent with GIS practice (see Q2) and avoids ambiguity when one of 110 dots is hovered among selected ones.
- **Contrast of the tool selection colors.** Computed from the WCAG relative-luminance formula on the hex/HSL values above (my calculation, approximate):
  - tldraw `hsl(214,84%,56%)` (≈ `#3182ED`): ≈ 3.8:1 vs white, ≈ 5.5:1 vs black.
  - Excalidraw `#6965db`: ≈ 4.7:1 vs white, ≈ 4.5:1 vs black.
  - Reported Figma `#0D99FF`: ≈ 3.0:1 vs white, ≈ 7.0:1 vs black.
  - So these are mid-luminance saturated hues that clear or nearly clear 3:1 against **both** white and black. That property matters most when the backdrop is arbitrary.
- **No canvas tool inspected dims unselected objects.** Their legibility strategy is a hue rarely found in artwork plus a constant-width stroke plus padding (Excalidraw's 4px gap keeps the outline off the object's own edge).
- **Dash patterns carry meaning:** solid means mine/selected; dashed means group, remote collaborator, or locked. This vocabulary can be reused (e.g. dashed = "pending" or "other user").

### Gaps
- Figma's exact selection stroke width (believed 1px), handle size, hover outline width and the official selection hex: no first-party spec found. `#0D99FF` comes only from weak third-party pages.
- Illustrator: the convention that selection highlight color = the layer's color (Layer Options color; Layer 1 = light blue) is widely known but was **not verified** from an Adobe page this session.
- Sketch, Miro, FigJam: no first-party documentation found on selection outline color, width or multi-selection rendering. Only the tldraw hover-area survey covered Sketch and Miro hit areas.
- I found no source on whether Figma draws a common bounding box in addition to per-object boxes for multi-select. I believe it does, from product use, but this is unverified.
- Marcin Wichary's "Designing selection colors" write-up ([aresluna.org](https://aresluna.org/designing-selection-colors)) turned out to be about Figma's *Selection Colors panel* (listing fills in a selection), not canvas outline rendering. It is not relevant.

---

## Q2. Web maps and GIS: how selected point features are rendered vs unselected (color, halo, enlargement, dimming, highlight layers)

### Takeaway
GIS desktop and SDK products draw selection in a single, deliberately "unnatural", high-luminance color: **cyan** (ArcGIS) or **yellow** (QGIS default, and ArcGIS JS hover/"temporary"). It is rendered as an outline or halo plus a translucent fill (ArcGIS JS: halo opacity 1, fill opacity 0.25). Hover and selection are given **different colors**. Consumer maps (Apple, Mapbox Standard) use state-driven restyling instead: a select color (Mapbox blue `hsl(214,94%,59%)`) and an **enlarged** selected marker (Apple). Dimming of non-selected features is not a default in any product inspected; it is left to the app via data-driven styling. Dense or overlapping selections are handled with pickers (ArcGIS Pro "Selection Chip"), clustering and spiderfy.

### Cited Findings

**ArcGIS Maps SDK for JavaScript (official typings, v4.32+)**
- The `View.highlights` collection ships two named presets:
  - `default`: `{ color: "cyan", haloOpacity: 1, fillOpacity: 0.25, shadowColor: "black", shadowOpacity: 0.4, shadowDifference: 0.2 }`, used when `layerView.highlight()` is called with no options.
  - `temporary`: `{ color: "yellow", haloOpacity: 1, fillOpacity: 0.25 }`, "pre-configured for common use cases such as hovering over a feature in the view."
  — [HighlightOptions.d.ts (@arcgis/core)](https://cdn.jsdelivr.net/npm/@arcgis/core/views/support/HighlightOptions.d.ts); [ArcGIS JS API: HighlightOptions](https://developers.arcgis.com/javascript/latest/references/core/views/support/HighlightOptions/); [View.d.ts](https://cdn.jsdelivr.net/npm/@arcgis/core/views/View.d.ts)
- A highlight is a **halo** (outline) around the feature plus a fill ("area within the halo"). `fillOpacity` default is 0.25 and `haloOpacity` default is 1, each "multiplied with the opacity specified in `color`". A separate `haloColor` can be set. Shadow options (darkening the shadow in a 3D SceneView) work only on the `default` highlight. — [HighlightOptions.d.ts](https://cdn.jsdelivr.net/npm/@arcgis/core/views/support/HighlightOptions.d.ts)
- Apps can register more named highlight groups, and later entries take priority. The docs' own examples include `{ name: "selection", color: "#ff00ff", haloOpacity: 0.8, fillOpacity: 0.2 }` and `{ name: "table", color: "cyan", fillOpacity: 0.5, haloOpacity: 0 }`. — [View.d.ts](https://cdn.jsdelivr.net/npm/@arcgis/core/views/View.d.ts)

**ArcGIS Pro**
- The `SelectionOptions` API exposes:
  - `SelectionColor` / `DefaultSelectionColor`, and `SelectionFillColor` ("A null value indicates that no color is applied to polygon interiors").
  - `IsSelectionFillHatched`.
  - `ShowSelectionGraphic` (draw the selection shape while selecting).
  - `ShowSelectionChip`: "display the Selection Chip, when coincident or overlapping features are selected" (a picker for dense or overlapping hits).
  - `SelectionTolerance` (search tolerance in device units) and `KeepInvisibleFeaturesSelected`.
  — [ArcGIS Pro SDK: SelectionOptions members](https://doc.esri.com/en/arcgis-pro/latest/sdk/api-reference/topic25686.html)
- Users migrating from ArcMap report its bright **cyan selection halo** made selections easy to see. In ArcGIS Pro, "changing the selection color alone" does not reproduce that halo, and selected features are harder to see. — [Esri Community: Selection halos for ArcPro](https://community.esri.com/t5/mining-questions/selection-halos-for-arcpro/td-p/246238)

**QGIS**
- By default, selected features render in **yellow**. This can be changed globally (Settings → Options → Canvas & Legend → Default Map Appearance) and overridden per project (Project → Properties → General → Selection Colour). — [Arkance: QGIS Change Selection Colour](https://ukcommunity.arkance.world/hc/en-us/articles/21549939964178-QGIS-Change-Selection-Colour)
- Newer QGIS also supports **per-layer** selection rendering via `QgsVectorLayerSelectionProperties`:
  - `selectionColor()`: "An invalid color indicates that the default (i.e. project level) selection color should be used instead."
  - `selectionSymbol()`: "the symbol used to render selected features in the layer. May be None if the default symbol should be used instead."
  - `selectionRenderingMode()`.
  - So a layer can swap in an entirely different symbol, such as a larger marker with an outline, for selected features.
  — [PyQGIS: QgsVectorLayerSelectionProperties](https://qgis.org/pyqgis/master/core/QgsVectorLayerSelectionProperties.html)

**Mapbox GL JS and the Mapbox Standard style**
- `feature-state` "Retrieves a property value from the current feature's state." State "is not part of the GeoJSON or vector tile data, and must be set programmatically on each feature". Features need an integer-castable `id`, and "["feature-state"] can only be used with **paint** properties that support data-driven styling". In practice that rules out layout properties such as `icon-size` and leaves paint properties such as `circle-radius`, `circle-stroke-*` and `icon-halo-*`. — [Mapbox Style Spec: expressions](https://docs.mapbox.com/style-spec/reference/expressions/)
- The canonical hover example toggles `fill-opacity` with `['case', ['boolean', ['feature-state', 'hover'], false], 1, 0.5]` (hover = 1, else 0.5, color `#627BC1`), using `setFeatureState({source, id}, {hover: true})` on mousemove and resetting it on mouseleave. — [Mapbox GL JS example: Create a hover effect](https://docs.mapbox.com/mapbox-gl-js/example/hover-styles/)
- Mapbox Standard exposes three featuresets: buildings, place labels and POIs. Interactions set built-in `highlight` and `select` feature states. The iOS example sets `select: true` on tapped buildings, using the configurable `colorBuildingSelect` (default `"hsl(214, 94%, 59%)"`, blue). It also sets `hide: true` on a POI when replacing it with a custom view annotation, and resets with `resetFeatureStates`. — [Mapbox iOS: Standard style interactions](https://docs.mapbox.com/ios/maps/examples/standard-style-interactions-ui-kit/), [Mapbox Flutter: Standard interactions](https://docs.mapbox.com/flutter/maps/examples/standard_interactions/)

**Apple MapKit / Apple Maps**
- `MKMarkerAnnotationView` (the Maps-app balloon marker) has `markerTintColor`, `glyphImage`/`glyphText`, and `selectedGlyphImage` ("An image to display when the user selects the marker"). Default `displayPriority` is `defaultLow`, so markers can be hidden by collision. — [Apple Developer: MKMarkerAnnotationView](https://developer.apple.com/documentation/mapkit/mkmarkerannotationview)
- A third-party wrapper of the API (Titanium) documents the selected glyph at **40×40 pt vs 20×20 pt** for the normal glyph on iOS. This reflects the selected marker balloon growing to about twice its size. — [Titanium SDK Map.Annotation docs](https://titaniumsdk.com/api/modules/map/annotation.html) (secondary source)

**Halos for legibility on busy basemaps (cartography)**
- Esri: "The complexity of most basemaps presents the challenge of maintaining the legibility of labels over a dense network of lines and symbols while not breaking up or concealing information." Work on accessible basemaps is bringing halos back. (From the search-result excerpt; the page itself returned 403 when fetched.) — [Esri ArcGIS Blog: Polishing your halo](https://www.esri.com/arcgis-blog/products/arcgis-living-atlas/mapping/polishing-your-halo)
- One web-GIS product caps label halo width at one quarter of the font size. That is a product constraint, not a standard. — [GOAT docs: Labels](https://goat.plan4better.de/docs/map/layer_style/labels)

### Inferences
- **Two-color convention: hover ≠ selected.** ArcGIS JS ships cyan for selection and yellow for hover/temporary. Different hues for hover vs selection is an established GIS convention worth copying when many items are on screen.
- **Halo plus translucent fill** (ArcGIS 1.0 / 0.25) is the GIS analogue of the canvas-tool outline. For point symbols it reads as a ring around the marker.
- **Contrast of GIS selection colors.** My WCAG luminance calculation, approximate:
  - Cyan `#00FFFF`: ≈ 1.25:1 vs white, ≈ 16.7:1 vs black.
  - Yellow `#FFFF00`: ≈ 1.07:1 vs white, ≈ 19.6:1 vs black.
  - Mapbox `hsl(214,94%,59%)`: ≈ 3.4:1 vs white, ≈ 6.1:1 vs black.
  - So the GIS defaults assume mid or dark map backgrounds. **On a light floor plan, cyan or yellow alone would fail 3:1**, and the canvas-tool mid-blue/violet (or a two-tone ring) is the better precedent.
- **Enlarge-on-select** is a consumer-map convention (Apple about 2×). GIS desktop does it only through custom selection symbols (QGIS `selectionSymbol`). In Mapbox GL it must be done with paint properties (e.g. `circle-radius`), because feature-state cannot drive layout properties like `icon-size`.
- **Dimming unselected features is not a product default** anywhere inspected. It is achievable with feature-state or data-driven opacity, but adopting it would be a design choice rather than a convention.

### Gaps
- **Google Maps** (consumer and Maps Platform): no official spec found for selected-marker rendering (enlargement, color change, dimming). Not researched in depth due to tool budget.
- **ArcGIS Pro default selection color RGB** and whether Pro draws a halo by default: the SDK page lists the properties but not default values. The community thread implies ArcMap's default was cyan.
- **ArcGIS Online/Enterprise Map Viewer** selection styling (beyond the JS SDK defaults it is built on): not separately verified.
- **QGIS** exact default RGBA (believed 255,255,0) and the version that introduced per-layer selection properties: not confirmed on a first-party page this session.
- Apple Maps app behavior for dimming or "other" pins: not documented.

---

## Q3. Do any of these tools draw group shapes (convex hulls, bubbles) around a multi-selection, or always per-item? How are hulls used where they exist?

### Takeaway
Selection in canvas tools and GIS is **per-item outlines plus, at most, an axis-aligned common bounding box**, never a hull. Hulls appear in two other places. Leaflet.markercluster shows a convex hull on hover to preview a cluster's spatial **coverage** (transient, informational, not selection). In the visualization research literature, Bubble Sets and LineSets were built for exactly the case of set members interleaved with non-members in a fixed layout.

### Cited Findings
- Excalidraw draws a common **rectangular** bounding box (`getCommonBounds`, dashed) around multi-selections, and dashed rectangles around groups. There are no hull shapes. — [Excalidraw interactiveScene.ts](https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/renderer/interactiveScene.ts)
- tldraw draws one rectangular selection box (`strokeRect(0,0,width,height)`) plus per-shape indicators. — [tldraw SelectionForegroundOverlayUtil.ts](https://github.com/tldraw/tldraw/blob/main/packages/tldraw/src/lib/overlays/SelectionForegroundOverlayUtil.ts)
- Figma draws "a blue box … around each object" in a multi-selection. — [Figma Help: Select layers and objects](https://help.figma.com/hc/en-us/articles/360040449873-Select-layers-and-objects)
- **Leaflet.markercluster coverage hull:**
  - `showCoverageOnHover` (default **true**): "When you mouse over a cluster it shows the bounds of its markers."
  - On `clustermouseover` it adds `new L.Polygon(e.layer.getConvexHull(), this.options.polygonOptions)` and removes it on mouseout. `polygonOptions` defaults to `{}`, meaning Leaflet's default Path style.
  - `getConvexHull()` is also public for apps to draw their own hulls.
  - Related dense-point affordances: `zoomToBoundsOnClick` and `spiderfyOnMaxZoom`, which fans out overlapping markers at max zoom, with `spiderfyDistanceMultiplier` and custom `spiderfyShapePositions`.
  — [Leaflet.markercluster README](https://github.com/Leaflet/Leaflet.markercluster/blob/master/README.md), [MarkerClusterGroup.js](https://github.com/Leaflet/Leaflet.markercluster/blob/master/src/MarkerClusterGroup.js)
- **Bubble Sets** (Collins, Penn, Carpendale; IEEE TVCG 15(6):1009–1015, 2009) target data whose "primary data relation" has meaningful spatial positions, where "members of the same set are not necessarily adjacent in the primary layout". The technique draws "a continuous, possibly concave, isocontour" around set members **without disrupting the primary layout**, at interactive speeds. — [Bubble Sets project page (U. Calgary)](https://innovis.cpsc.ucalgary.ca/Research/BubbleSets); [paper PDF](https://vis.pku.edu.cn/course/datavis_f23/material/bubble_sets_revealing_set_relations_with_isocontours_over_existing_visualizations.pdf)
- A Bubble Sets implementation is available as a plugin in AntV G6, a graph library. — [AntV G6: Bubble Sets plugin](https://g6.antv.antgroup.com/en/manual/plugin/bubble-sets)
- LineSets (InfoVis 2011, Microsoft Research) is a related technique that links set members with a curve instead of an area. — [LineSets paper PDF](https://microsoft.com/en-us/research/uploads/prod/2011/12/linesets_infovis2011.pdf)

### Inferences
- For ~110 interleaved fixtures, a convex hull around a selection would visually **include unselected fixtures** inside it, which is misleading. That is why mainstream tools stay per-item. If a group shape is wanted (e.g. "this zone's lights"), Bubble Sets-style concave isocontours are the established answer for interleaved membership. Use them as a secondary overlay; they don't replace per-item rings.
- Leaflet's hull is used as a **transient hover preview of extent**, not a persistent selection mark. That is a reasonable precedent for showing "what would be affected" on hover over a group or tag chip.

### Gaps
- No evidence found of Figma, Illustrator, Sketch, Miro, FigJam, ArcGIS or QGIS ever drawing hulls for selection. Absence was inferred from docs and code, not from an explicit statement.
- The Leaflet default Path style (believed to be blue `#3388ff`, weight 3, fill opacity 0.2) was not verified from Leaflet docs this session.
- LineSets: only the paper's existence and URL were confirmed; its content was not reviewed.

---

## Q4. Published design-system guidance on selection and focus states, and WCAG non-text contrast (3:1)

### Takeaway
WCAG 2.x SC 1.4.11 requires visual information that identifies a component's **state (including selected and focused)**, and graphical objects needed for understanding, to reach **3:1 against adjacent colors**. It does **not** require 3:1 between the selected and unselected appearance of a component when the two don't appear next to each other. Usable specifics from Material, Apple HIG and Esri Calcite could not be retrieved this session.

### Cited Findings
- **SC 1.4.11 text:** "The visual presentation of the following have a contrast ratio of at least 3:1 against adjacent color(s): User Interface Components: Visual information required to identify user interface components and states, except for inactive components or where the appearance of the component is determined by the user agent and not modified by the author; Graphical Objects: Parts of graphics required to understand the content, except when a particular presentation of graphics is essential to the information being conveyed." — [W3C Understanding SC 1.4.11 Non-text Contrast (WCAG 2.2)](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)
- On states: "visual information necessary to indicate state, such as whether a component is selected or focused must also ensure that the information used to identify the control in that state has a minimum 3:1 contrast ratio." — [W3C Understanding SC 1.4.11](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)
- On state-to-state change: "This success criterion does not require that changes in color that differentiate between states of an individual component meet the 3:1 contrast ratio when they do not appear next to each other." — [W3C Understanding SC 1.4.11](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)
- "Adjacent colors" for UI components means the colors next to the component. Example: for an input with a white interior, dark border and white exterior, the adjacent color is the white external background. — [W3C Understanding SC 1.4.11](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)
- Material Web's focus ring is implemented as `outline: $width solid currentColor` with separate `inward-offset` / `outward-offset` tokens (so the ring sits outside the component, separated by a gap). The token values were not retrieved. — [material-web focus-ring.scss](https://github.com/material-components/material-web/blob/main/focus/internal/_focus-ring.scss)

### Inferences
- For a floor plan, each selection ring is the "visual information required to identify … state". Its **adjacent colors are both the plan background and the fixture's own fill**, and fixture fills may be any light color. A single-color ring can't guarantee 3:1 against arbitrary fills, which argues for a **two-tone ring**: a dark or accent ring separated from the fixture by a light gap or halo, or vice versa. This is the same idea as Material's outward-offset focus ring and Excalidraw's 4px padding.
- Because the 3:1 rule applies against adjacent colors, not between states, a selected fixture can keep its own (possibly light) color as long as the selection ring meets 3:1 against what touches it.
- Dimming unselected fixtures, if used, must not drop the fixtures (graphical objects needed for understanding) below 3:1 against the plan background, or they would fail the graphical-objects clause.

### Gaps
- **Material Design 3** state-layer opacities (commonly cited as hover 8%, focus 10%, pressed 10%, dragged 16%) and focus-indicator thickness/offset (commonly cited as 3dp / 2dp): **not verified**. m3.material.io is JS-rendered and returned no content, and the token files moved in the repo. Only a weak secondary claim was found that "only one state layer is applied at a time".
- **Apple HIG** guidance on selection, focus and map annotations: not retrieved (JS-rendered pages).
- **Esri Calcite** focus-ring spec (believed to be a 2px brand-color outline with offset): source file path not found and not verified.
- Mapbox style docs have no accessibility or contrast guidance for selection that I could find.
