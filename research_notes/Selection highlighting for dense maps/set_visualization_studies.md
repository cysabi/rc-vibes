# Set visualization studies: region vs per-item vs line overlays for a selection of point items on a map

Scope note: these notes cover the empirical set-visualization literature (Bubble Sets, LineSets, Kelp/KelpFusion, GMap, MapSets, SimpleSets, surveys, readability studies). The target use case is one "selected" subset of about 10–110 point items on a floor plan, with selected and unselected items spatially interleaved. Every controlled study found here tests **multiple** sets or groups. None tests one selected set against a field of unselected items, so anything said about the single-set case is inference (marked as such).

## Q1. Bubble Sets (Collins, Penn, Carpendale 2009) and the LineSets study (Alper et al. 2011): accuracy, time, preference, and why regions struggle with interleaved or non-contiguous sets

### Takeaway
In the only direct controlled comparison (12 participants, maps and social networks, 50–200 elements, 3–5 sets), LineSets beat Bubble Sets overall on accuracy (88.5% vs 80%) and time (13.4 s vs 17.1 s). The gap came entirely from detail tasks: set membership (88.9% vs 66.7%) and intersection (40% faster), and the hardest datasets (86.5% vs 65.6%). 11 of 12 participants preferred LineSets. Regions were criticized for covering too much area for scattered sets, for overlapping when they shouldn't, and for sometimes appearing to include elements of other sets. On overview tasks Bubble Sets did as well, and some users felt it conveyed "grouping" better.

### Cited Findings
**Bubble Sets mechanism (as described by the Alsallakh et al. 2016 survey)**
- Bubble Sets (IEEE TVCG 15(6), InfoVis 2009) builds one contour per set that "includes all of its elements and excludes all other elements if possible". It computes an energy map over the pixels inside the convex hull of the set's elements, then runs marching squares. Sets get semi-transparent colors. "Unlike Euler diagrams, two regions might overlap even if their sets share no elements. Such overlaps should be understood as artefacts that encode no information." — [Alsallakh et al. 2016, CGF 35(1)](https://www.cvast.tuwien.ac.at/sites/default/files/bibcite/459/publik_262247.pdf)
- The survey says Bubble Sets was demonstrated with "tens of elements" over a scatter plot, graph or map. Depending on overlap, it "can usefully visualize between 4 and 20 sets and still retain enough visibility of the context". An inverse-distance potential field (Vihrovs et al. 2014, "VPF*14") was proposed to reduce artefacts "but might result in disconnected regions". — [Alsallakh et al. 2016](https://www.cvast.tuwien.ac.at/sites/default/files/bibcite/459/publik_262247.pdf)
- Bubble Sets' stated purpose: data whose primary layout is spatially meaningful, where "members of the same set are not necessarily adjacent in the primary layout". It draws a "continuous, possibly concave, isocontour" without disturbing that layout. — [Bubble Sets project page (via search snippet; page unreachable)](https://innovis.cpsc.ucalgary.ca/Research/BubbleSets)

**LineSets critique of regions** (Alper, Henry Riche, Ramos, Czerwinski, "Design Study of LineSets, a Novel Set Visualization Technique", IEEE TVCG 17(12), InfoVis 2011)
- "The use of convex hull set representations can be problematic for scattered or fragmented data sets. In particular, when representing points of interest on a map, a hull is likely to misrepresent the true support area of a set since it covers a larger region than necessary". Their example: a set with four elements in the four corners of a map produces a hull that "covers the whole map, and thus, erroneously intersects all possible sets on that map." — [Alper et al. 2011](https://www.microsoft.com/en-us/research/uploads/prod/2011/12/linesets_infovis2011.pdf)
- On Bubble Sets: it "may still produce geometries that overlap each other when elements are scattered in space… although the algorithm strives to minimize false inclusions, in some cases sets may still appear to include elements from other sets." — [Alper et al. 2011](https://www.microsoft.com/en-us/research/uploads/prod/2011/12/linesets_infovis2011.pdf)

**LineSets Study 1 design**
- Within-subjects, 12 researchers (6 female, ages 24–31), 19" 1280×1024 screen.
- Conditions: 2 techniques × 2 data types (hotels on a map, social network) × 3 difficulty levels × 4 tasks.
- Difficulty levels: easy = 50 elements, 3 sets, 5 intersections; medium = 100 elements, 4 sets, 10 intersections; difficult = 200 elements, 5 sets, 30 intersections.
- Bubble Sets images came from the authors' implementation. LineSets images were **hand-drawn in Photoshop** ("ideal" sketches), not generated.
- Tasks: T1 number of sets, T2 set size comparison, T3 membership, T4 intersection.

— [Alper et al. 2011](https://www.microsoft.com/en-us/research/uploads/prod/2011/12/linesets_infovis2011.pdf)

**LineSets Study 1 results**
- Accuracy overall: LineSets 88.5% (SD 1.9) vs Bubble Sets 80% (SD 2.7), F(1,11)=13.5, p=.004.
  - T3 membership: 88.9% vs 66.7%.
  - Difficult datasets: 86.5% vs 65.6%.
  - T1, T2, T4: no significant accuracy difference.
  - Participants made significantly more errors on the **map** data than on the social network.
- Time overall: 13.4 s vs 17.1 s, F(1,11)=5.09, p=.045, about 20% faster.
  - T3: 17.9 s vs 23.6 s.
  - T4: 13.8 s vs 23.5 s (about 40% faster).
  - Overview tasks T1/T2: no significant difference. This refuted H1, which predicted Bubble Sets would be faster on overview tasks.
- Preference: LineSets rated significantly higher, F(1,11)=28.3. 11 of 12 preferred LineSets. The one dissenter was also the only participant more accurate with Bubble Sets.
- Comments: 10 participants said Bubble Sets was unsuitable for intersection and common-attribute tasks. "Two participants expressed that Bubble Sets gave them a better sense of 'grouping'". Size comparison split 6/6: people who counted preferred LineSets, people who estimated preferred Bubble Sets.

— [Alper et al. 2011](https://www.microsoft.com/en-us/research/uploads/prod/2011/12/linesets_infovis2011.pdf)

**Sketching exercise**
- Before the study, 6 of 12 participants indicated membership with "only color". 3 used straight lines plus color, 2 used concave enclosures, 1 used a hybrid.
- After the study, 2 still used color only. 4 used LineSets-like lines. 4 used a hybrid that "enclosed elements spatially grouped in simple concave geometries and used lines to connect outliers to the rest of the elements".

— [Alper et al. 2011](https://www.microsoft.com/en-us/research/uploads/prod/2011/12/linesets_infovis2011.pdf)

**Independent replication**
- Jianu et al. 2014 (about 800 MTurk users) found the relative BubbleSets/LineSets results "similar to those reported by LineSets authors". In their setting, however, BubbleSets was slightly *better* on group-membership tasks (see Q4). — [Jianu et al. 2014, IEEE TVCG 20(11)](https://openaccess.city.ac.uk/15379/1/paper_TVCG2014_groupinfo.pdf)

### Inferences
- The LineSets advantage is concentrated in membership and intersection tasks with many intersecting sets. A single selected set has no intersections, so the strongest documented reason to prefer lines over regions (overlap clutter) mostly does not apply. The remaining relevant critique is false inclusion of interleaved non-members and hull area that is too large for scattered members.
- "Only color" was the most common spontaneous way untrained participants marked set membership (6/12 before exposure). That suggests per-item coloring is the intuitive default encoding.
- The participants' hybrid sketches (enclose tight clusters, connect outliers with lines) anticipate KelpFusion and SimpleSets.
- Caveat: LineSets' study stimuli were idealized hand drawings, which may favor LineSets over a real algorithmic output.

### Gaps
- I could not access the original Bubble Sets PDF (author site unreachable; PKU mirror refused the connection). I could not verify whether the 2009 paper included any user evaluation. Secondary sources describe the LineSets 2011 study as the first readability comparison involving Bubble Sets, and the Alsallakh survey notes a general "lack of empirical user studies". "No formal study in the original" is therefore likely but unverified.
- No study isolated the effect of Bubble Sets' non-member exclusion (false inclusions) on errors. The literature only describes it qualitatively.

## Q2. Kelp Diagrams (Dinkla et al. 2012) and KelpFusion (Meulemans et al. 2013): user study results and how non-member inclusion was handled

### Takeaway
Kelp Diagrams has no user study that I could find. Its design routes links so they never cross non-member elements and clips each element's "bubble" to its Voronoi cell. KelpFusion (13 participants, Boston restaurants, 4–5 sets, 12–49 elements per set) beat Bubble Sets by about 30 accuracy points (86.5% vs 54.5%) and was 27% faster. It matched LineSets on accuracy and was 12% faster. Users rated it the most aesthetic and best at conveying grouping. KelpFusion handles non-members with explicit legibility rules: it never fills a face that contains a non-member, and it avoids large filled faces because they obscure the map.

### Cited Findings
**Kelp Diagrams** (Dinkla, van Kreveld, Speckmann, Westenberg, Computer Graphics Forum 31(3), EuroVis 2012)
- Method: "links elements that are part of the same set by constructing minimum cost paths over a tangent visibility graph". Two styles exist for overlapping sets: nested and striped. — [Kelp Diagrams, EG Digital Library](https://diglib.eg.org/handle/10.1111/v31i3pp0875-0884)
- Each element is surrounded by "a circle clipped to its Voronoi cell to avoid overlaps". "The graph links are routed so that they do not cross elements that do not belong to the respective set." — [Alsallakh et al. 2016](https://www.cvast.tuwien.ac.at/sites/default/files/bibcite/459/publik_262247.pdf)
- The paper's comparison with two existing methods claims "a more consistent and clear depiction of both element locations and their set relations". This is a visual comparison, not a user study. — [Kelp Diagrams, EG Digital Library](https://diglib.eg.org/handle/10.1111/v31i3pp0875-0884)
- KelpFusion explicitly did not test Kelp Diagrams "as KelpFusion achieves a superset of Kelp Diagrams". — [Meulemans et al. 2013](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/12/kelpfusion_tvcg2013.pdf)

**KelpFusion design** (Meulemans, Henry Riche, Speckmann, Alper, Dwyer, IEEE TVCG 19(11), InfoVis 2013)
- A hybrid of lines and filled areas built on shortest-path graphs. A single parameter t moves the graph from a minimum spanning tree to a convex hull. — [Meulemans et al. 2013](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/12/kelpfusion_tvcg2013.pdf)
- Each node has an "allocation area": its Voronoi cell intersected with a disk of radius r. Smoothing is followed by subtracting allocation areas "to avoid false memberships as a result of smoothing". (The extracted text is truncated mid-sentence; I infer it refers to other nodes' allocation areas.) — [Meulemans et al. 2013](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/12/kelpfusion_tvcg2013.pdf)

**KelpFusion legibility rules**
- Rationale: "filling all faces results in visualizations with false memberships, ambiguity, and areas that are too visually dominant". A face is filled only if all four rules hold:
  1. Area is below a threshold (|f| / |nodes(f)| < A). "Large faces obscure much of a background map, are too visually dominant, and may suggest a higher density."
  2. The face "does not contain a node in N \ S_i". Filling over a non-member "incorrectly implies that n is actually part of S_i or… may hide the other set memberships of n".
  3. The face's interior does not overlap an edge of a lower set.
  4. A shared-boundary rule with lower sets.
- The authors also suggested thinning instead of filling, and right-angle crossings.

— [Meulemans et al. 2013](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/12/kelpfusion_tvcg2013.pdf)

**KelpFusion study design**
- Within-subjects: 3 techniques × 4 tasks × 2 difficulty levels × 3 repetitions = 72 multiple-choice questions.
- 13 participants (7 M, 6 F, ages 27–47), non-programmers. Questions capped at 40 s. Sessions about 60 min.
- Data: Boston restaurant locations from Bing Maps. Datasets had 4–5 sets, 12–49 elements per set, and up to 2 four-set intersections. Colors from ColorBrewer.
- Tasks: SizeOverview, SizeCount, SetIntersection, SetMembership. In SetMembership, the target was "highlighted… by coloring the node yellow".

— [Meulemans et al. 2013](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/12/kelpfusion_tvcg2013.pdf)

**KelpFusion accuracy** (Bubble Sets / LineSets / KelpFusion; technique effect F(2,24)=64.96, p<0.0001)

| Task | Bubble Sets | LineSets | KelpFusion |
|---|---|---|---|
| All tasks | 54.5% | 84.3% | 86.5% |
| SizeOverview (n.s.) | 85.9% | 80.8% | 84.6% |
| SizeCount | 41.0% | 82.1% | 84.6% |
| SetIntersection | 37.2% | 84.6% | 82.1% |
| SetMembership | 53.8% | 89.7% | 94.9% |

- KelpFusion and LineSets were not significantly different on accuracy.

— [Meulemans et al. 2013](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/12/kelpfusion_tvcg2013.pdf)

**KelpFusion time** (mean seconds; F(2,24)=44.69, p<0.0001)

| Task | Bubble Sets | LineSets | KelpFusion |
|---|---|---|---|
| All tasks | 17.17 | 14.19 | 12.41 |
| SetMembership | 17.19 | 10.10 | 9.60 |

- KelpFusion was about 12% faster than LineSets and 27% faster than Bubble Sets.
- SizeCount: KelpFusion was 35% faster than Bubble Sets and 28% faster than LineSets. The authors hypothesize subitizing of small filled clusters.

— [Meulemans et al. 2013](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/12/kelpfusion_tvcg2013.pdf)

**KelpFusion preferences and comments**
- Confidence: LineSets and KelpFusion beat Bubble Sets (p<0.001).
- Clutter: LineSets was rated least cluttered (p<0.01) because it occludes the least map.
- Grouping: LineSets conveyed less grouping than KelpFusion (p<0.03), because "the linear design… implies a sequential order which is not present". Bubble Sets was rated *least* effective at conveying grouping (vs KelpFusion p<0.001, vs LineSets p<0.03). The authors attribute this to occlusion from overlapping regions. Quotes: "the overlapping color blobs made it near impossible…", "visual chaos", "could not find a thing in there".
- Aesthetics: KelpFusion more pleasing than Bubble Sets (p<0.001). 8 of 13 said it was the most aesthetic overall.
- Lines: 7 of 13 said lines were "wiggly and visually distracting when counting".

— [Meulemans et al. 2013](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/12/kelpfusion_tvcg2013.pdf)

**KelpFusion stated limitations**
- "Bubble Sets were originally developed for non-overlapping sets. We did not include non-overlapping datasets… Thus, Bubble Sets may remain a good choice when representing simpler set arrangements, in which sets rarely overlap."
- Spatial arrangement of elements was not controlled, and the datasets "contained relatively few clusters of points".

— [Meulemans et al. 2013](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/12/kelpfusion_tvcg2013.pdf)

### Inferences
- KelpFusion's rules are a ready-made recipe for "regions only where they are honest":
  - Fill an area only when it contains no non-member and is small.
  - Otherwise fall back to thin links, or to individual element marks (the Kelp "bubble" per element).
- With heavy interleaving, few faces pass rule 2. The result degrades gracefully into per-item bubbles plus links.
- For one selection, rule 1 (large faces "obscure much of a background map… may suggest a higher density") is directly relevant to a floor plan where the base layout must stay readable.
- The study sizes (12–49 elements per set) overlap the target range of 10–110 items, so the magnitudes are roughly transferable. They are not single-set, though.
- The authors concede Bubble Sets "may remain a good choice" when sets rarely overlap. A single selection is the extreme of "rarely overlap", so Bubble Sets' worst measured failures (overlap clutter: 37% intersection accuracy) would not occur. Non-member enclosure under interleaving remains untested.

### Gaps
- I did not access the full Kelp Diagrams PDF. Its exact design requirements (e.g., an "element visibility" principle) come from secondary descriptions only. No user study of Kelp Diagrams was found.
- Neither paper reports a metric for "inclusion of non-members" in competing techniques. KelpFusion prevents it by construction but did not measure it in Bubble Sets stimuli.

## Q3. GMap (Voronoi), MapSets, SimpleSets: design rationales, evaluations, failure modes (fragmentation, holes, non-members inside regions)

### Takeaway
Space-partitioning region methods (GMap's Voronoi "countries") fail when same-group items are spatially scattered. The regions fragment, and users then cannot tell whether two fragments belong together: GMap was significantly worse in that scenario (p<0.001), but best when groups were spatially cohesive. Adding explicit links between fragments fixed it. Contiguous variants (MapSets) guarantee connected, non-overlapping regions, but interleaved inputs force "octopus-like" shapes, and the authors themselves recommend relaxing to fragmentation or overlaps in that case. SimpleSets (2024) abandons "one shape per set" and covers each category with several simple shapes (convex islands, gently bending banks, single-point circles) because complex shapes raise cognitive load. MapSets and SimpleSets have no user studies.

### Cited Findings
**GMap**
- GMap (Gansner, Hu, Kobourov, IEEE PacificVis 2010) groups vertices into regions using a Voronoi diagram of the vertices plus the bounding-box corners, drawn as countries on a map. — [GMap, IEEE Xplore](https://ieeexplore.ieee.org/document/5429590)
- "The countries in SOM-based and GMap-based visualizations are fragmented, i.e., they are represented by several disconnected regions." Because "graph layout and graph clustering are two separate steps, the result is often fragmented". "Such fragmentation makes it difficult to identify the correct regions and can result in misinterpretation of the map." The authors' "own informal experiments indicate that users prefer contiguous maps, and that the removal of country fragmentation is considered more important than preserving other graph characteristics" (informal, not a controlled study). — [Kobourov, Pupyrev, Simonetto, EuroVis 2014 short paper](https://www2.cs.arizona.edu/~paolosimonetto/Papers/EuroVis14_1.pdf)

**Jianu et al. 2014 on GMap**
- Their 2 s "intuitive membership" task split into four layouts:
  - Two nodes in well-separated groups.
  - Nodes in one continuous set.
  - Nodes in adjacent groups.
  - Nodes in "spatially scattered node clusters that belonged to the same group".
- GMap outperformed all other techniques in the first and third (p<0.001) "but performs poorly in the fourth category (p<0.001)". Reason: there is "no explicit connection" between the disjoint same-group regions.
- They attribute GMap's strengths to "large, continuous color areas" readable with peripheral vision. Eye-tracking showed GMap users fixating near, not on, highlighted nodes, with shorter fixations.
- A hand-edited GMap that linked "disjointed set areas" outperformed BubbleSets on fast membership and equaled it on deliberative membership.
- GMap's memorability advantage came from group labels: retrieval fell from about 0.23 to 0.1 without labels, the same as the other techniques.

— [Jianu et al. 2014](https://openaccess.city.ac.uk/15379/1/paper_TVCG2014_groupinfo.pdf)

**Saket et al. 2014 (contiguous regions)**
- Saket, Simonetto, Kobourov, Börner, "Node, Node-Link, and Node-Link-Group Diagrams: An Evaluation" (arXiv 1404.1911; InfoVis 2014 / IEEE TVCG). They used GMap-based node-link-group (NLG) diagrams but "avoid[ed] this problem by using only contiguous regions".
- Group-based task accuracy was highest in NLG (mean 94.83%).
- "Adding links, or links and group representations, does not negatively impact performance (time and accuracy) of node-based tasks."
- They state their group-task result "contradicts the results in Jianu et al.… but is likely explained with use of fragmented maps in their study and contiguous maps in ours".
- 36 participants, 12 per condition. The extraction also reported group-task times of 10.8 s (NLG) vs 13.4 s (NL) vs 14.6 s (N). These came from an automated summary of the ar5iv page and are not independently verified.

— [Saket et al. 2014](https://ar5iv.arxiv.org/html/1404.1911)

**MapSets** (Efrat, Hu, Kobourov, Pupyrev; GD 2014; JGAA 19(2):571–593, 2015)
- Problem statement: with fixed membership and fixed positions, "some methods produce fragmented regions, while other produce contiguous (connected) regions that may contain overlaps even if the input clusters are disjoint. Both… have a detrimental effect on the interpretation."
- MapSets guarantees contiguity and disjointness and optimizes convexity, "as the convex hull best captures cohesive grouping according to Gestalt theory". They cite Riche and Dwyer's finding that "convex and simple regions is a primary factor impacting readability".
- They argue overlapping regions for disjoint sets "might mislead the viewer about the disjointness of the sets". Fragmented maps are "difficult to read as human perception of color changes based on surrounding colors".

— [Efrat et al. 2015](https://jgaa.info/index.php/jgaa/article/download/paper364/2581)

**MapSets evaluation and failure mode**
- Evaluation is algorithmic and visual only: ink ratio, runtime, and side-by-side images versus GMap, BubbleSets and KelpFusion, e.g., US senators by party at home-city locations. "The comparison of different visualization techniques is not supported by an objective qualitative validation."
- Failure mode: "some input graphs require complex 'octopus'-like regions, even in an optimal solution… In these cases it would be better to relax the constraints and to allow either fragmented regions (as in GMap), or intersections between regions (as in BubbleSets and KelpFusion)." They call for "an in-depth human subjects evaluation".

— [Efrat et al. 2015](https://jgaa.info/index.php/jgaa/article/download/paper364/2581)

**SimpleSets** (van den Broek, Meulemans, Speckmann; IEEE TVCG 31(1), VIS 2024)
- Critique of prior work: existing methods "use one single shape to connect all points in the same category. Since these points can be scattered throughout the plane, the shapes… are often complex and may intersect". Bubble Sets, LineSets and KelpFusion "create many intersections between shapes, which clutter the visualizations, increasing the cognitive load". MapSets shapes are "complex and highly irregular" and "heavily obfuscate the base map". — [SimpleSets, arXiv 2407.14433](https://arxiv.org/html/2407.14433v1)
- Design: partition each category into "islands" (convex clusters) and "banks" (point sequences with at most 2 bends and limited turning angles). Isolated points become their own pattern, drawn as a circle centered on the point. — [SimpleSets](https://arxiv.org/html/2407.14433v1)
- Non-member handling: patterns that contain other points within their dilated shape are "admissible but not desirable", discouraged by an "intersection delay" in the greedy partitioning. Overlaps between shapes use local stacking orders, preferring orders that avoid "cut-outs" around other points. — [SimpleSets](https://arxiv.org/html/2407.14433v1)
- Evaluation: quantitative only, against VPF*14 (inverse-distance Bubble Sets variant) and ClusterSets. Metrics: shape complexity (inflection points, perimeter/area, curvature), number of shapes, coverage, density distortion. SimpleSets scores better on most measures except number of shapes. "No user study": the authors say one "might be insightful and could settle lingering questions". — [SimpleSets](https://arxiv.org/html/2407.14433v1); [IEEE VIS 2024 listing](https://ieeevis.org/year/2024/program/paper_v-full-1153.html)
- Stated open problem: "How can we handle datasets that contain both very dense and quite sparse areas? Such datasets are abundant in practice, which limits the practical application of current set visualizations for categorical point data." — [SimpleSets](https://arxiv.org/html/2407.14433v1)

**F2-Bubbles** (Wang et al., IEEE VIS 2021)
- Targets Bubble Sets' "overlapping artifacts" by computing overlays "considering set elements and their non-set neighbors", with interactive editing.
- Evaluated by quantitative comparison and case studies, not a user study.

— [F2-Bubbles, IEEE VIS 2021](https://content.ieeevis.org/year/2021/paper_v-full-1435.html)

### Inferences
- Known region failure modes on interleaved data, in one place:
  - Fragmentation (GMap/Voronoi). Users can't tell fragments belong together.
  - Overlap artefacts and false inclusion (Bubble Sets).
  - Tortuous "octopus" shapes when contiguity is forced (MapSets).
  - Holes and cut-outs around non-members (Bubble Sets, SimpleSets).
  - Occlusion of the base map (MapSets, KelpFusion rule 1).
- For a binary selected/unselected split of interleaved floor-plan items, a Voronoi/GMap-style partition would produce many fragments. A MapSets-style contiguous partition would produce octopus shapes. Neither is recommended by its own authors for such inputs.
- SimpleSets' strategy is the closest published design answer to interleaving. Group only locally pure runs or clusters into simple shapes and mark the rest individually, accepting several shapes per set instead of one complex shape. It is unvalidated by users, and its authors flag mixed dense/sparse data as unsolved.
- Jianu's "linked GMap" result suggests that if fragments are used, explicit connectors between same-set fragments restore membership judgments.

### Gaps
- No user study of MapSets, SimpleSets, ClusterSets or F2-Bubbles was found.
- I did not access the GMap PacificVis 2010 PDF directly. Its description comes from IEEE abstract snippets and later papers.
- No study measured performance as a function of the degree of interleaving (e.g., the fraction of non-members inside a set's hull).

## Q4. Surveys and readability studies: Alsallakh et al. 2016, Wallinger et al. 2021, Jianu et al. 2014 and others; readability vs number of sets/elements and interleaving

### Takeaway
The survey literature classifies overlays into regions, lines, glyphs/icons and hybrids:
- **Regions** give Gestalt closure but interfere with the base visualization and cap the number of sets.
- **Lines** use less ink but lose closure, impose a false order, and clash with bases that already use lines.
- **Glyphs** are the "lightweight" choice for showing element membership and location without depicting sets as objects.

The largest study (Jianu et al., about 800 users, 26 non-overlapping groups) found BubbleSets best for group-membership judgments and plain node coloring worst. Colored nodes did fine when groups were large and cohesive but "showed very poor performance" when clusters were interspersed. Most of their errors were due to *similar colors among many groups*. Any group overlay cost about 25% accuracy on reading the base (path tracing), though Saket et al. found no such penalty with contiguous regions.

### Cited Findings
**Alsallakh et al. 2016, "The State-of-the-Art of Set Visualization" (Computer Graphics Forum 35(1):234–260)**
- Overlays are for when "set memberships are a secondary information in the data that needs to be analysed in the context of other data features", e.g., elements on a map. Four categories: regions, lines, glyphs/icons, hybrids. — [Alsallakh et al. 2016](https://www.cvast.tuwien.ac.at/sites/default/files/bibcite/459/publik_262247.pdf)
- Regions: "The use of coloured regions… facilitates perceiving objects within one region as one group, following Gestalt laws of closure. However, these regions might interfere with and compromise the perception of the underlying visualization. This can impose severe limits on the number of sets that can be overlaid before the visualization is cluttered." — [Alsallakh et al. 2016](https://www.cvast.tuwien.ac.at/sites/default/files/bibcite/459/publik_262247.pdf)
- Lines: "Line-based overlays reduce the ink used… at the cost of following the Gestalt law of closure." LineSets imposes "an artificial ordering". "Lines might interfere with the base visualization if it already uses lines for a different purpose". LineSets "were shown to scale better than region-based methods and can overlay up to tens of sets over hundreds of elements". LineSets interaction "makes certain lines salient, while the other lines are drawn thinner". — [Alsallakh et al. 2016](https://www.cvast.tuwien.ac.at/sites/default/files/bibcite/459/publik_262247.pdf)
- Glyphs/icons: often it is "enough to represent set membership for the individual elements in the base visualization, without the need to represent each of the sets as a connected object". "Glyphs and icons offer a lightweight alternative to overlay set information on an underlying visualization in a minimal way. While not suited to encode set relations, they can be designed to effectively encode element membership of the sets and to reveal the location[s]…" of a set's elements. Icons, however, may need "a serial scan" without interaction. Color composition only works for 2–3 sets. — [Alsallakh et al. 2016](https://www.cvast.tuwien.ac.at/sites/default/files/bibcite/459/publik_262247.pdf)
- Summary table, overlay weaknesses: "Often limited in the number of elements and sets. Undesired layout artefacts (overlaps, crossing, shapes, etc.)". Also: "There is a clear lack of empirical user studies". — [Alsallakh et al. 2016](https://www.cvast.tuwien.ac.at/sites/default/files/bibcite/459/publik_262247.pdf)

**Jianu, Rusu, Hu, Taggart 2014, "How to Display Group Information on Node-Link Diagrams: An Evaluation" (IEEE TVCG 20(11):1530–1541)**
- Design:
  - About 800 MTurk subjects, between-subjects, 10 task types.
  - Data: book co-purchase network of about 850 books in 26 **non-overlapping** groups, neato layout. Groups were "not necessarily spatially co-located".
  - Identical coloring across conditions (BubbleSets transparency compensated).
  - Tight time limits: 2 s intuitive membership, 7 s deliberative.
- Group tasks: "BubbleSets users were most accurate, with LineSets users in close second". BubbleSets outperformed colored nodes in 3 of 4 group tasks, GMap in 2 of 4, LineSets in 1 of 4. "colored nodes appears to be the least effective method".
- Deliberative membership (7 s): BubbleSets beat GMap (p<0.001, r=0.5), colored nodes (p<0.001, r=0.54) and LineSets (p<0.05, r=0.36).

— [Jianu et al. 2014](https://openaccess.city.ac.uk/15379/1/paper_TVCG2014_groupinfo.pdf)

**Jianu et al. 2014: interleaving and color**
- "Group membership errors in the colored nodes condition were small when groups were large and cohesive… Conversely, when nodes from many clusters where interspersed, colored nodes showed very poor performance."
- "Colored nodes… offers the least amount of color area". Users "perform a discrete comparison between small color patches by moving their gaze back and forth". Region methods allow tracing "the continuous area from one node to the other".
- "An important number of errors… were linked to assignment of similar colors to distinct sets." BubbleSets and LineSets had "a clear advantage… because of their reduced reliance on color".

— [Jianu et al. 2014](https://openaccess.city.ac.uk/15379/1/paper_TVCG2014_groupinfo.pdf)

**Jianu et al. 2014: cost to the base layer and line misreadings**
- "Visually encoding group information over basic node-link diagrams incurs an accuracy penalty of about 25% in solving network tasks" (path tracing). There were "few differences between GMap, BubbleSets, and LineSets".
- LineSets users "seemed to judge that two nodes are connected if they are visited by the same set curve". This hurt degree and neighbor tasks.

— [Jianu et al. 2014](https://openaccess.city.ac.uk/15379/1/paper_TVCG2014_groupinfo.pdf)

**Jianu et al. 2014: open questions**
- "BubbleSets gives control over how tightly contours are fitted around nodes, thus creating a continuum between space filling methods and individual nodes. It would be interesting to quantify the effect of this parameter."
- They expect differences to vary with "number and size of groups, spatial separation of groups, or their overlap".

— [Jianu et al. 2014](https://openaccess.city.ac.uk/15379/1/paper_TVCG2014_groupinfo.pdf)

**Saket et al. 2014: contradicting result**
- With contiguous regions, adding links or group regions did not hurt node-based tasks. They note their network-task results contradict Jianu et al., "where… 'node coloring' performed better than NLG diagrams (GMap and BubbleSets) for network-based tasks". — [Saket et al. 2014](https://ar5iv.arxiv.org/html/1404.1911)

**Wallinger, Jacobsen, Kobourov, Nöllenburg 2021, "On the Readability of Abstract Set Visualizations" (IEEE TVCG 27(6):2821–2832)**
- Compared LineSets, EulerView and MetroSets on abstract (non-spatial) music data, online.
- Element-based tasks: LineSets and MetroSets about 92% accuracy, EulerView about 65%.
- Set-based tasks: MetroSets about 85%, LineSets about 64%, EulerView about 50%.
- On the large dataset's T5, EulerView and LineSets fell to about 14% accuracy.
- The findings are scoped to "less than 10-12 sets, less than 80-100 elements, and elements being members of 1-4 sets".
- Participants "had difficulty distinguishing colors in all three systems". EulerView regions "became muddled when many sets overlapped".

— [Wallinger et al. 2021](https://arxiv.org/pdf/2101.08155)

**Other studies (via Wallinger et al.'s related-work summary)**
- Rodgers et al.: crowdsourced test of Bubble Sets, LineSets, KelpFusion, EulerView and SetNet on combined set+network tasks (11–64 elements, 3–7 sets). SetNet and EulerView "significantly outperform the other three". — [Wallinger et al. 2021](https://arxiv.org/pdf/2101.08155); [Rodgers et al. record](https://research.brighton.ac.uk/en/publications/a-task-based-evaluation-of-combined-set-and-network-visualization/)
- Baimagambetov et al. found Bubble Sets the "least inaccurate" of SetNet, Bubble Sets and WebCola. — [Wallinger et al. 2021](https://arxiv.org/pdf/2101.08155)
- Chapman et al. 2014: linear diagrams outperformed Euler diagram variants on set-only tasks. — [Wallinger et al. 2021](https://arxiv.org/pdf/2101.08155)

### Inferences
- Jianu's central weakness of per-item coloring is confusing *similar hues among many groups*. A single selection drawn in one high-contrast color against neutral unselected items largely removes that confound. Their interspersed-cluster failure was measured with 26 hue-coded groups, not one highlighted set, so it should not be read as evidence against per-item highlighting for a single selection.
- The ~25% base-reading penalty (Jianu) versus no penalty (Saket) suggests overlay cost depends on region quality (contiguous vs fragmented) and on how much the overlay competes with the base's own lines. Floor plans are line drawings (walls), so the survey's warning that line overlays clash with line-based bases, and Jianu's finding that set curves get misread as connections, both argue against LineSets-style connectors on a floor plan.
- Readability evidence exists for roughly ≤5 sets and ≤200 elements on maps (LineSets, KelpFusion), and ≤10–12 sets and ≤80–100 elements for abstract data (Wallinger). The 10–110 item target sits inside these tested ranges.

### Gaps
- No study systematically varied interleaving (spatial mixing of members and non-members) as an independent variable. Jianu's four-category split of task 1 is the closest.
- The participant count for Wallinger et al. was not extracted.
- Details of Rodgers et al. and Baimagambetov et al. come from Wallinger's summary, not the primary papers. I believe Rodgers et al. appeared in Information Sciences 2016, but I did not verify this.

## Q5. Do these papers address single-set highlighting (one "selected" set over all items)? What do they recommend for one set, and when should regions be avoided?

### Takeaway
None of the studied techniques is evaluated in the one-selected-set-versus-everything-else scenario. All studies use 3–26 sets or groups. The literature touches the single-set case only indirectly:
1. In the studies themselves, target items are signalled by per-item highlighting, e.g., "coloring the node yellow".
2. Interactive versions emphasize one set by making it salient and thinning the others.
3. The survey says element-level glyphs suffice when sets need not be shown "as a connected object".
4. Regions are discouraged when they would be large, would enclose non-members, would fragment, or would need tortuous shapes. The authors' recommended fallbacks are links between fragments, several simple shapes, or individual marks.

### Cited Findings
**How the studies signal targets and emphasis**
- KelpFusion study: "Highlighting for the SetMembership task was done by coloring the node yellow." — [Meulemans et al. 2013](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/12/kelpfusion_tvcg2013.pdf)
- Jianu et al.'s membership tasks present "two highlighted nodes"; the highest-degree task presents "a highlighted group". — [Jianu et al. 2014](https://openaccess.city.ac.uk/15379/1/paper_TVCG2014_groupinfo.pdf)
- LineSets interaction emphasizes one set: "Interaction makes certain lines salient, while the other lines are drawn thinner to reduce visual clutter." — [Alsallakh et al. 2016](https://www.cvast.tuwien.ac.at/sites/default/files/bibcite/459/publik_262247.pdf)

**When sets need not be connected objects, and when Bubble Sets may still fit**
- It is often enough "to represent set membership for the individual elements… without the need to represent each of the sets as a connected object… glyphs and icons can be used". Glyphs "effectively encode element membership of the sets and… reveal the location[s]". — [Alsallakh et al. 2016](https://www.cvast.tuwien.ac.at/sites/default/files/bibcite/459/publik_262247.pdf)
- "Bubble Sets may remain a good choice when representing simpler set arrangements, in which sets rarely overlap." — [Meulemans et al. 2013](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/12/kelpfusion_tvcg2013.pdf)

**Avoid large regions over the base**
- KelpFusion avoids large filled faces because they "obscure much of a background map, are too visually dominant, and may suggest a higher density". — [Meulemans et al. 2013](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/12/kelpfusion_tvcg2013.pdf)
- A hull over scattered points "covers a larger region than necessary". — [Alper et al. 2011](https://www.microsoft.com/en-us/research/uploads/prod/2011/12/linesets_infovis2011.pdf)

**Avoid regions that enclose non-members**
- A filled face containing a non-member "incorrectly implies" membership. — [Meulemans et al. 2013](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/12/kelpfusion_tvcg2013.pdf)
- Bubble Sets "may still appear to include elements from other sets". — [Alper et al. 2011](https://www.microsoft.com/en-us/research/uploads/prod/2011/12/linesets_infovis2011.pdf)

**Avoid fragmented regions without connections**
- Users could not judge whether disconnected same-group regions belong together. GMap was significantly worse there (p<0.001), and adding links fixed it. — [Jianu et al. 2014](https://openaccess.city.ac.uk/15379/1/paper_TVCG2014_groupinfo.pdf)
- Fragmentation "can result in misinterpretation of the map". — [Kobourov, Pupyrev, Simonetto 2014](https://www2.cs.arizona.edu/~paolosimonetto/Papers/EuroVis14_1.pdf)

**Avoid forced-contiguous, tortuous shapes**
- "'octopus'-like regions… In these cases it would be better to relax the constraints". — [Efrat et al. 2015](https://jgaa.info/index.php/jgaa/article/download/paper364/2581)
- A single complex shape per category leads to "high cognitive load". SimpleSets recommends multiple simple shapes plus single-point circles. — [SimpleSets 2024](https://arxiv.org/html/2407.14433v1)

**Avoid lines over a base that already uses lines**
- "Lines might interfere with the base visualization if it already uses lines for a different purpose". — [Alsallakh et al. 2016](https://www.cvast.tuwien.ac.at/sites/default/files/bibcite/459/publik_262247.pdf)
- LineSets curves were misread as connections. — [Jianu et al. 2014](https://openaccess.city.ac.uk/15379/1/paper_TVCG2014_groupinfo.pdf)
- Lines imply a "sequential order which is not present". — [Meulemans et al. 2013](https://www.microsoft.com/en-us/research/wp-content/uploads/2016/12/kelpfusion_tvcg2013.pdf)

**Unprompted user drawings**
- Untrained users most often used "only color" to mark membership (6/12). After exposure, several drew hybrids: enclose tight clusters, connect outliers. — [Alper et al. 2011](https://www.microsoft.com/en-us/research/uploads/prod/2011/12/linesets_infovis2011.pdf)

### Inferences
- **Primary encoding for one selection: per-item marks.** Use a high-contrast highlight color, ring or halo on each selected item, with unselected items de-emphasized. This avoids every region failure mode listed above (false inclusion, fragmentation, octopus shapes, map occlusion). Jianu's documented weakness of node coloring (similar hues among many groups) mostly doesn't apply to a single hue against neutral items.
- **What per-item marks lose.** The Gestalt "grouping" signal and the peripheral-vision advantage of large color areas that made GMap and BubbleSets fast in Jianu's study. Per-item marks also need enough color area to be found; small dots underperformed in Jianu partly for lack of "color area".
- **Optional secondary layer, if grouping matters.** A KelpFusion/SimpleSets-style local grouping:
  - Draw small region shapes only around spatially pure clusters of selected items, where the shape contains no unselected item (KelpFusion rule 2).
  - Keep shapes small (rule 1).
  - Leave isolated selected items as individual circles (SimpleSets single-point patterns).
  - Don't force one connected region (MapSets' octopus warning) and don't connect fragments with long lines across a line-drawn floor plan (line misreadings, base interference).
- **Bubble Sets for a single set.** It is plausible because there is no overlap clutter (the KelpFusion authors' own caveat). With heavy interleaving, though, the contour must either swallow unselected items (false inclusion) or snake around them with thin bridges and cut-outs. No study measured user error for that case.
- **Thresholds.** No study gives a numeric threshold, such as a fraction of non-members inside the hull, beyond which regions should be dropped. A design heuristic would be needed, e.g., "fill only faces with zero non-members", taken directly from KelpFusion's rule.

### Gaps
- I found no paper that evaluates single-set (selection or highlight) overlays against per-item highlighting on spatial layouts. The literature is multi-set throughout.
- Nothing found evaluates set overlays specifically on floor plans or indoor maps.
- The perceptual literature on highlighting and visual pop-out (e.g., color vs halo vs size for one target subset) is outside these set-viz papers and was not covered here. It would be needed to choose the specific per-item encoding.
