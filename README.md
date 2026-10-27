# Shear Wall Optimizer

Browser tool for placing concrete shear walls on an architectural plan so the center of rigidity (COR) lines up with the center of mass (COM). Rigid diaphragm, uniform floor mass, walls continuous over the full height.

## Run

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # engine unit tests
```

## Workflow

1. **Plan** – upload (or drop) the PDF and pick the floor plan page.
2. **Scale** – click two points a known distance apart and enter the distance, or pick the sheet scale if the PDF is at full print size.
3. **Geometry** – one of:
   - **Import Bluebeam markups** (shown when the page has PDF markup annotations): the largest Polygon becomes the slab outline, Polygons inside it become voids, and thin rectangle (Square) markups become shear walls.
   - **Detect walls from PDF**: imports the heaviest black wall linework on the sheet. T and L shapes become separate straight walls.
   - Trace the outline, voids and walls by hand.
4. **Building** – stories, story height, wall thickness, boundary condition.
5. **Optimize** – changes wall lengths, removes walls if needed, and sets one thickness for all walls (see below). Lock walls in the results table to keep them unchanged; **Undo** restores the original layout and thickness.

6. **Wall design check** – runs every wall through SkyCiv Quick Design's ACI 318-19 concrete shear wall calculator (`3003-aci-concrete-wall-calculator`). Add your SkyCiv username and API key under **SkyCiv API settings** in the header (from [platform.skyciv.com/api](https://platform.skyciv.com/api)). Each wall costs 0.01 API credits. The results table links to the PDF report (expires about an hour after the run) and to **Open** the calculation on the SkyCiv platform with the inputs pre-filled.

### SkyCiv wall check

`src/skyciv.ts` builds one `POST https://qd.skyciv.com/run` per wall, following `skyciv-ai-skills/run-quick-design`. The endpoint allows browser (CORS) requests, so no backend is needed. Inputs are converted to the calculator's metric units.

- **Loads**: the user enters the strength-level base shear V (kips) and the exponent k. V is distributed to the levels per ASCE 7 §12.8.3, F_x = C_vx·V with C_vx = h_x^k / Σh_i^k; floors have equal weight, so w cancels. This gives the story shears V_x and overturning moments M_x shown in the sidebar. Every level has the same walls, so each wall takes its governing share from the rigid-diaphragm analysis (incl. ±5% accidental torsion, larger of X and Y loading) of the base values: V_u = share·V, M_u = share·M_base. P_u = 0.9 × wall self-weight. The check is at the base, where both are largest for a uniform wall.
- **Reinforcement**: two curtains, vertical #/spacing and horizontal #/spacing. The vertical bar count and `long_Spacing` are derived the same way as the calculator's UI, which the API doesn't do for you.
- **Height**: the calculator caps H at 25 m. ACI §11.5.4.3 uses h_w/l_w only through α_c, which is constant once h_w/l_w ≥ 2, so the cap is harmless; the app warns when it isn't.
- **Units**: runs are sent in imperial by default (in, kip, kip-ft, ksi). They use `current_unit_system: "imperial"` plus the `conversion_factors` map back to metric, the same format the Quick Design platform saves, so the PDF report is in imperial units. A **Units sent to SkyCiv** switch can send metric instead. The **Open** link always passes metric values, the calculator's native units.
- **Shear only**: optional. The app then judges each wall on its shear ratio alone; bending, axial and detailing results stay in the report and in the row tooltip, marked "ignored". M_u is still sent, and toggling doesn't require a re-run.
- **Scope**: ACI 318-19 Ch. 11 in-plane wall design only. No special structural wall (Ch. 18), boundary element or slenderness checks.

Credentials are kept in memory, or in `localStorage` if "Remember on this device" is ticked, and are never written to project JSON.

### Bluebeam markups

`src/markups.ts` reads annotations through pdf.js. The Square's rectangle is taken as the wall location because that is what Bluebeam displays and prints. A stored appearance stream can be stale (on the sample sheet, two T markups draw mirrored in pdf.js). Wall length comes from the heavy appearance bar inside the Square when one spans it; otherwise the Square is trimmed by the median padding measured on the matched ones. Red Line and PolyLine markups become wall centerlines when **Red line markups as walls** is ticked (off by default). Each straight segment within 5% of horizontal or vertical is snapped square; angled segments and segments under 3 ft are dropped. The markup's own color is used, not its appearance stream, which on the sample sheet draws the red lines in black. Other lines, text, stamps and large boxes are counted and ignored. Bluebeam's own scale calibration isn't read, so set the scale in step 2.

### Wall detection

`src/detect.ts` walks the pdf.js operator list and collects black or red, axis-aligned, long and thin bars: filled or outlined rectangles and thick straight strokes, with their outline weight. Red means a strong red: R ≥ 150 with G and B ≤ 100, so orange, pink and grey don't count. After filtering by real-world size (0.25–3 ft thick, ≥ 3 ft long) and the colors ticked in step 3, it keeps the bars in the heaviest line weight of each color. Black and red are weighed separately, so a red markup isn't dropped for being lighter than heavy black linework. On the sample sheet that is exactly the 16 lateral-element legs; the architectural walls are drawn lighter.

### Optimizer

Wall locations are fixed. Only lengths change, within the max length, the slab edge and voids, and the min length if shortening is allowed. A wall end within ~1 ft of another wall (a T/L junction) stays put and the other end grows; free walls grow about their center.

X_CR depends only on Y walls and Y_CR only on X walls, so each direction is solved independently. It drives S = Σ R_j·u_j to zero (u_j = wall offset from the COM) with the minimum-change step ΔR_j = −S·u_j / Σu², clamping walls at their limits and passing the remainder to the others. Rigidities are then converted back to lengths, rounded to 6 in, and polished with a local search. See `src/engine/optimizer.ts`.

**Removal** (optional): if lengths alone leave e/L above 0.5%, the optimizer tries removing 1, 2, … unlocked walls in that direction, re-balancing lengths for each subset. It keeps the best result, preferring the fewest removals, and always keeps the minimum wall count on at least 2 lines.

**Thickness**: every wall uses one thickness, set within a min and max. A uniform t scales every R equally, so it has no effect on the COR or eccentricity. The optimizer therefore picks the thinnest thickness, in 1 in steps, that keeps total stiffness ΣR in each direction at least at the original layout's. If the max can't get there, it says so.

The results panel updates as you draw: COM, COR, e/L in each direction, and each wall's governing shear as a percentage of V, enveloping ±5% accidental torsion.

## Calculations

`src/engine/` is plain TypeScript with no UI dependencies:

- Wall rigidity uses the cantilever and fixed deflection equations from the Seismic Design Review Workbook (Figs 8.12, 8.14), with G = 0.4E. E cancels because every wall uses the same concrete.
- COM is the slab area centroid with voids subtracted.
- COR, eccentricity, and direct plus torsional shear follow workbook §8.7–8.8 (ASCE 7 §12.8.4).

Plan geometry is stored in PDF points and converted to feet (y up) for analysis. **Save JSON** stores the project; re-upload the same PDF before loading it.
