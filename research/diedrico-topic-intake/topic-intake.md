# Diedrico Topic Intake — lesson-cycle-001 Pipeline Bootstrap

Access date: 2026-05-31

## Executive summary

`/work/diedrico-lessons/` currently contains no `catalog.md`, no `backlog.md`, and no lesson directories. `/work/diedrico/specs/` is present but contains no files, so the initial lesson backlog must be derived from the Diedrico frontend source, especially `frontend/src/config/toolFamilies.ts`, toolbar/dialog/panel components, tool classes, command factories, and world/domain models.

Recommended first lesson topic: **001 — Diedrico workspace orientation and first free point**. This is the lowest-risk first end-to-end pipeline target because it exercises the live app, project startup/new-project flow if available, the toolbar/active plane/status UI, and the simplest geometry creation path (`Free Point`) without depending on advanced construction preconditions.

If the Coder needs a narrower target because the lesson-production pipeline is not yet complete, use the same topic as a smoke lesson: short screen capture, synthetic narration, subtitles, and metadata proving the archive/catalog loop works.

## Existing lesson output state

Observed with `find /work/diedrico-lessons -maxdepth 3`: only the root directory exists.

Required bootstrap actions for the Coder:

1. Create `/work/diedrico-lessons/catalog.md` as the authoritative index.
2. Create `/work/diedrico-lessons/backlog.md` seeded from source-derived topics below.
3. Create `/work/diedrico-lessons/lessons/001-workspace-orientation-free-point/` for the first lesson attempt or document a precise blocker there.

## Source-of-truth observations

### Specs

- `/work/diedrico/specs/` exists but currently has no files.
- Because specs are empty, component and tool source is the practical source of truth for this first backlog.

### User-visible tool families

From `/work/diedrico/frontend/src/config/toolFamilies.ts`:

| Family | Tools / labels | Notes for lessons |
|---|---|---|
| Point | `Free Point`, `Intersection Point` | Best entry point; Free Point has simple click-to-place interaction. |
| Line | `Line Through Points`, `Parallel Line`, `Perpendicular Line`, `Tangent (Point)`, `Tangent (Parallel)` | Progress from simple two-point line to constraint-based constructions. |
| Segment | `Segment` | Natural after point/line basics. |
| Circle | `Circle` | Center then circumference point workflow. |
| Guide | `Guide` | Diedrico-specific projection helper: perpendicular to hinge line. |
| Transport | `Transport` | Tooltip says `Not yet implemented`; keep out of early lesson backlog or mark blocked. |
| 3D Elements | `3D Point`, `3D Line`, `3D Segment`, `3D Plane`, `Projection Plane` | Advanced lessons after learners understand 2D projections and plane selector. |
| Examples | `Folding Plane Setup`, `Quick 3D Line`, `Quick 3D Segment`, `Interactive Setup` | Useful for demonstrations and setup shortcuts; not foundational user workflows. |

### Visible app areas relevant to lesson scripts

From toolbar/dialog/panel source:

- Startup/project flow: `StartupDialog.vue` and `NewProjectDialog.vue` expose Google sign-in/project selection/new-project UI. Lesson scripts should handle either startup state or existing workspace state gracefully.
- Main toolbar: `Toolbar.vue` includes New Project, Open Project, active plane selector, toggle 3D projections, grid toggle, and fit-to-view actions.
- Active plane: `PlaneSelector.vue` provides active plane selection with `data-testid="plane-selector"` and plane options by ID.
- Status: `StatusBar.vue` shows active plane and 3D coordinates.
- Elements: `ElementsPanel.vue` groups 2D elements by projection plane and has a 3D Elements section.
- 3D view: `ThreeView.vue` includes controls for showing planes, showing 2D elements on planes, and showing grids.

### Implementation/source concepts available for advanced topics

Tool and command files show teachable construction concepts:

- 2D primitives: `PointTool.ts`, `LineTool.ts`, `SegmentTool.ts`, `CircleTool.ts`.
- Derived constructions: `IntersectionTool.ts`, `ParallelLineTool.ts`, `PerpendicularLineTool.ts`, tangent tools.
- Projection helpers: `GuideTool.ts`, `ProjectionSetupFactory.ts`, `HingeLineSequenceFactory.ts`.
- 3D reconstruction: `Create3DPointTool.ts`, `Create3DLineTool.ts`, `Create3DSegmentTool.ts`, `Create3DPlaneTool.ts`, `CreateProjectionPlaneTool.ts`.
- Domain models: `Point3D.ts`, `Line3D.ts`, `Plane.ts`, `World.ts`, plus projection-plane and hinge-line models.

## Recommended initial backlog ordering

Use this ordering in `/work/diedrico-lessons/backlog.md` unless live UI discovery reveals a major blocker:

1. **Workspace orientation and first free point** — start/open/create a project as needed, identify canvas, toolbar, active plane, status bar, and place one free point.
2. **Active projection planes and the plane selector** — switch active planes and explain why geometry belongs to a projection plane.
3. **Creating a line through two points** — create two points, draw a line, inspect the Elements panel.
4. **Segments and measured relationships** — draw a segment between points and contrast segment vs infinite line.
5. **Circles from center and circumference point** — create a circle and explain dependency on two points.
6. **Intersection point construction** — derive a point from two existing elements.
7. **Parallel and perpendicular lines** — constraint-based line construction from a reference and point.
8. **Guide lines and hinge-line intuition** — use Guide to connect projection-plane reasoning to dihedral geometry.
9. **3D view orientation** — toggle/show projection planes, 2D elements on planes, and grids in the 3D panel.
10. **Create a 3D point from two 2D projections** — first true dihedral reconstruction lesson.
11. **Create a 3D line from two projections**.
12. **Create a 3D segment from projections**.
13. **Create a 3D plane from traces**.
14. **Auxiliary projection plane / folding setup** — use folding plane setup and projection-plane tools.
15. **Tangent line constructions** — advanced circle/line dependency topic.
16. **Process tree and construction history** — explain actions/process organization once several constructions exist.
17. **Properties and styling** — select elements, inspect metadata/dependencies, style changes if stable.
18. **Project persistence workflow** — new/open/save behavior after the geometry lessons are stable.

Defer **Transport** until implementation status is confirmed because its tooltip says it is not yet implemented.

## Recommended first lesson detail

### Slug

`001-workspace-orientation-free-point`

### Audience

New Diedrico user with no prior app familiarity; basic geometry vocabulary only.

### Learning goal

By the end, the learner can recognize the main workspace regions, identify the active projection plane, select the Free Point tool, place a point, and see it listed in the Elements panel/status context.

### Suggested narration outline

1. "This is Diedrico, a workspace for dihedral geometry constructions."
2. "The toolbar contains construction tools; the plane selector tells us which projection plane receives new 2D elements."
3. "We begin with the simplest object: a free point."
4. "Choose the Point family and the Free Point tool, then click on the canvas."
5. "The point appears on the active projection plane and is tracked in the elements list."
6. "This first point will become the building block for lines, segments, circles, and later 3D reconstructions."

### Playwright notes for Coder

- Probe `http://127.0.0.1:5173/` first; do not start the server if unreachable.
- Prefer accessible labels and `data-testid` selectors from components where available: `toolbar-new-project`, `plane-selector`, `plane-selector-button`, `toolbar-toggle-projections`.
- The startup/project dialog may require a branch in the script: if a new-project button/dialog is visible, create a local lesson project; otherwise continue with the loaded workspace.
- Keep the first capture short and robust: orient UI, place one point, briefly show status/elements panel.

## Risks and gaps

| Risk/gap | Impact | Recommendation |
|---|---|---|
| Empty `/work/diedrico/specs/` | Acceptance text expects backlog to cite specs/components if newly created, but specs offer no topics. | Cite that specs were empty and seed backlog from `frontend/src` components/tools. |
| Startup auth/project flow may vary | First live lesson may block before reaching canvas. | Coder should branch around visible startup state and record blocker if login/project selection prevents workspace access. |
| Transport tool marked not implemented | A lesson could fail if queued too early. | Exclude/defer Transport until a discovery cycle confirms implementation. |
| Advanced 3D tools require constructed prerequisites | Early 3D lessons could be flaky without setup shortcuts. | Teach 2D primitives and projection-plane basics first; use Examples family later for setup-heavy demos. |

## Sources

All sources accessed 2026-05-31; read-only under `/work/diedrico`.

- `/work/diedrico/specs/` — empty directory at intake.
- `/work/diedrico/frontend/src/config/toolFamilies.ts` — tool family labels, IDs, tooltips, implementation notes.
- `/work/diedrico/frontend/src/components/dialogs/StartupDialog.vue` — startup/project selection UI.
- `/work/diedrico/frontend/src/components/dialogs/NewProjectDialog.vue` — new project UI.
- `/work/diedrico/frontend/src/components/toolbars/Toolbar.vue` — toolbar actions and test IDs.
- `/work/diedrico/frontend/src/components/toolbars/PlaneSelector.vue` — active projection-plane selector.
- `/work/diedrico/frontend/src/components/toolbars/StatusBar.vue` — active plane and coordinate display.
- `/work/diedrico/frontend/src/components/panels/ElementsPanel.vue` — 2D/3D elements organization.
- `/work/diedrico/frontend/src/components/panels/ThreeView.vue` — 3D view controls.
- `/work/diedrico/frontend/src/tools/*.ts` and `/work/diedrico/frontend/src/commands/factories/*.ts` — construction capabilities.
