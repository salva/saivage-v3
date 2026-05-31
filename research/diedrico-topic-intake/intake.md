# Diedrico Topic Intake — Lesson Cycle 001

Access date: 2026-05-31

## Executive summary

- Existing lesson output store `/work/diedrico-lessons/` has no `catalog.md`, no `backlog.md`, and no lesson artifacts yet.
- `/work/diedrico/specs/` exists but currently contains no files, so the initial topic backlog must be grounded primarily in `/work/diedrico/frontend/src/` source.
- The Diedrico app is a Vue 3/Vite single-page drawing/dihedral-geometry application with a 2D SVG canvas, left-side Elements/Actions panels, a 3D overlay view, active-plane selector, and toolbar tool families.
- First lesson recommendation: **001 — First projection-plane walkthrough: create free points and a line on P_H**. It is foundational, requires only initialized local world state, avoids Google Drive authentication, avoids advanced multi-plane prerequisites, and exercises the most stable UI/domain concepts: active plane, free point, line-through-two-points, elements/actions panels, status bar, and canvas.
- The coder should create `catalog.md` and `backlog.md` in `/work/diedrico-lessons/`, seed the backlog from the ordered list below, and attempt lesson 001 if the Diedrico reachability probe succeeds.

## Existing output state

Observed by read-only shell inspection:

```text
/work/diedrico-lessons/catalog.md: MISSING
/work/diedrico-lessons/backlog.md: MISSING
find /work/diedrico-lessons -maxdepth 3 -type f: no files listed
```

Implication: cycle 001 must bootstrap both index files. Since no previous lesson exists, topic `001-first-projection-plane-walkthrough` can be used without collision.

## Source evidence used

### Specs

`/work/diedrico/specs/` produced no files in `find /work/diedrico/specs -maxdepth 3 -type f`, so there are no current spec documents to cite for the backlog.

### Application shell and usable startup mode

`/work/diedrico/frontend/src/App.vue` wires the active lesson surface:

- `Toolbar`
- `ElementsPanel`
- `ActionsPanel`
- `SvgCanvas`
- optional `ThreeView` overlay
- `StatusBar`
- `StartupDialog`

`/work/diedrico/frontend/src/application/appShell/ProjectSessionUseCases.ts` shows that if Google credentials are absent or Drive is unavailable, `initialize()` calls `session.initializeDefaultWorldIfNeeded()` and hides the startup dialog. This makes a local, non-authenticated walkthrough plausible and preferable for lesson 001.

`/work/diedrico/frontend/src/application/world/initializeWorld.ts` initializes the default Diedrico world through an `Initialize World` command and records fixed projection setup in the process tree.

### Teachable toolbar/tool concepts

`/work/diedrico/frontend/src/config/toolFamilies.ts` defines the user-facing tool families:

| Family | Tools | Lesson suitability |
|---|---|---|
| Point | Free Point, Intersection Point | Start with Free Point; Intersection follows after lines/circles exist. |
| Line | Line Through Points, Parallel Line, Perpendicular Line, Tangent variants | Start with Line Through Points; derived lines later. |
| Segment | Segment | Early after points/lines. |
| Circle | Circle | Early/mid after points. |
| Guide | Guide perpendicular to hinge line | Important dihedral concept after basic line/point interactions. |
| Transport | Transport placeholder, tooltip says not implemented | Do not schedule as an active lesson until implemented. |
| 3D Elements | 3D Point, 3D Line, 3D Segment, 3D Plane, Projection Plane | Advanced; requires creating/selecting projections on different planes. |
| Examples | Folding Plane Setup, Quick 3D Line, Quick 3D Segment, Interactive Setup | Useful for demo/advanced lessons and test fixtures. |

Tool source files confirm declarative multi-argument workflows via `ArgumentCollectorTool`: free points capture a position, lines/segments/circles collect point arguments, derived lines collect a reference line plus point, intersections collect two line/circle elements, and 3D tools collect projections/traces on different planes.

## Recommended first lesson

### Slug

`001-first-projection-plane-walkthrough`

### Audience

New Diedrico learner with no prior app knowledge.

### Learning goal

Explain the initialized dihedral workspace and demonstrate how to create two free points and a line through them on the horizontal projection plane `P_H`.

### Why this should be first

1. It teaches the app frame before deeper geometry: toolbar, canvas, active plane, status bar, elements/actions panels.
2. It uses the most basic construction path: Free Point → Free Point → Line Through Points.
3. It avoids Google Drive and project persistence, because local default initialization should be enough when no credentials are configured.
4. It creates visible artifacts that can validate Playwright recording and panels without needing complex geometric selection.
5. It is a good pipeline bootstrap target: short script, simple clicks, stable visual result.

### Suggested walkthrough outline

1. Open `http://127.0.0.1:5173/` and wait for the app shell.
2. Narrate the visible workspace: left panels, top toolbar, central SVG canvas, status bar, and active plane selector.
3. Confirm the active plane is `P_H` / horizontal projection plane; if needed, use the plane selector.
4. Select **Free Point** (`P` shortcut or toolbar button) and place point A on the canvas.
5. Place point B elsewhere on the same active plane.
6. Select **Line Through Points** (`L` shortcut or toolbar button) and click A then B.
7. Point out the Elements panel and Actions/process history updating as the construction grows.
8. Summarize: free points are independent anchors; the line depends on both points; later lessons use these basics for intersections, guides, and 3D reconstruction.

### Playwright cautions for coder

- Prefer robust selectors where present: `data-testid="status-bar"`, `data-testid="active-plane-status"`, `data-testid="plane-selector"`, and `data-testid="three-view-overlay"` exist in source.
- Toolbar buttons may be icon-only/family dropdown driven; if accessible labels are unreliable, inspect rendered DOM before hardcoding selectors.
- If startup dialog appears because Google credentials are active, avoid authenticating. Record the blocker or use any existing app-local fallback only if visible and supported by source behavior.
- Use canvas coordinate clicks only after measuring the rendered SVG/canvas bounding box.

## Initial backlog recommendation

Create `/work/diedrico-lessons/backlog.md` with an ordered list similar to this:

1. `001-first-projection-plane-walkthrough` — app frame, active plane, free points, line through two points. Sources: `App.vue`, `toolFamilies.ts`, `PointTool.ts`, `LineTool.ts`.
2. `002-segments-and-circles-from-points` — build a segment and a circle from point arguments. Sources: `SegmentTool.ts`, `CircleTool.ts`.
3. `003-intersections-as-dependent-points` — create intersections between two lines or line/circle, explaining dependency. Sources: `IntersectionTool.ts`, `IntersectionSequenceFactory`.
4. `004-parallel-and-perpendicular-lines` — derived line construction through a point from a reference line. Sources: `ParallelLineTool.ts`, `PerpendicularLineTool.ts`.
5. `005-guides-and-the-hinge-line` — guide perpendicular to hinge line, sibling guide behavior, and dihedral projection relation. Sources: `GuideTool.ts`, `GuideSequenceFactory`, default world initialization.
6. `006-elements-and-actions-panels` — read the object list/process tree, hover/selection relationships, and dependency thinking. Sources: `ElementsPanel.vue`, `ActionsPanel.vue`, process-tree read models.
7. `007-3d-point-from-two-projections` — reconstruct a 3D point from two 2D projections on different planes. Sources: `Create3DPointTool.ts`, three-presentation modules.
8. `008-3d-line-from-two-projections` — reconstruct a 3D line from paired projected lines. Sources: `Create3DLineTool.ts`.
9. `009-3d-segment-from-two-projections` — reconstruct a 3D segment from paired projected segments. Sources: `Create3DSegmentTool.ts`.
10. `010-3d-plane-from-traces` — create a plane from trace lines on different projection planes. Sources: `Create3DPlaneTool.ts`.
11. `011-auxiliary-projection-plane-folding-setup` — use folding-plane setup / auxiliary projection plane concepts. Sources: `CreateProjectionPlaneTool.ts`, example tools in `toolFamilies.ts`.
12. `012-tangent-lines-to-circles` — tangent through point and tangent parallel to reference line. Sources: `TangentLineToCircleThroughPointTool.ts`, `TangentLineToCircleParallelToLineTool.ts`.
13. `013-project-persistence-and-google-drive` — sign-in, project creation, save/open flow. Sources: `StartupDialog.vue`, `NewProjectDialog.vue`, `ProjectSessionUseCases.ts`, `GoogleDriveService.ts`. Schedule later because it may require credentials and operator setup.

Do **not** include the `Transport` placeholder as a production lesson until the implementation is real; `toolFamilies.ts` labels it “Not yet implemented”.

## Risks and gaps

- `/work/diedrico/specs/` is empty, so the backlog is source-derived rather than spec-derived.
- The current output store is empty; coder must create catalog/backlog before catalog acceptance can pass.
- Live UI behavior was not exercised in this research task; coder must still run the required `curl -fsS http://127.0.0.1:5173/` probe and Playwright walkthrough.
- Toolbar selector stability is uncertain because the active toolbar implementation may use icons/dropdowns rather than text buttons; coder should inspect runtime DOM.
