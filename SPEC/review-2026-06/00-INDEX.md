# Runtime Review Index — 2026-06

| ID | Title | Category | Severity | Transversality |
|----|-------|----------|----------|----------------|
| F01 | SupervisorRuntimeApi.startProject is synchronous-imperative, not reactive | Architectural / bad assumption | 5 | Cross-cutting |
| F02 | XState machines are decorative -- state transitions are not the execution driver | Architectural / bad abstraction | 4 | Cross-cutting |
| F03 | Six dead production modules with zero importers | Dead code | 3 | Local |
| F04 | GoalCardRunner.start() has no cancellation path while supervisor is paused/stopping | Bad assumption / correctness | 5 | Cross-cutting |
| F05 | Reviewer response parsing is brittle string matching | Bad assumption / fragile | 4 | Local |
| F06 | ActiveGoalNoteSinks is a process-global singleton map with no lifecycle management | Bad abstraction / leak | 3 | Local |
| F07 | actorKindFromId uses fragile prefix matching | Bad assumption / short-sighted | 2 | Cross-cutting |
| F08 | Snapshot context is `Record<string, unknown>` -- no type safety on persistence | Bad abstraction / type safety | 3 | Cross-cutting |
| F09 | SupervisorRuntimeApi.getActivityStatus returns hardcoded idle | Half-implemented | 4 | Cross-cutting |
| F10 | startProject ignores active runs and goal tree state | Half-implemented / bad assumption | 4 | Cross-cutting |
| F11 | RuntimeConfig and RuntimeAssembly are legacy interfaces not consumed by XState runtime | Dead code / over-engineering | 2 | Local |
| F12 | Tool argument parsing is ad-hoc casts with throw | Bad abstraction / duplication | 2 | Local |
| F13 | Runner controllers do not clean up LlmRunner/ProcessRunner instances on failure | Resource leak | 3 | Local |
| F14 | getStatus computes status ambiguously from internal mode | Bad assumption / half-implemented | 3 | Cross-cutting |
| F15 | Hard-coded tool names instead of shared definitions | Bad assumption / fragile coupling | 3 | Cross-cutting |
| F16 | No actor snapshot cleanup on goal/terminal card completion | Resource leak / over-retention | 2 | Local |
| F17 | StuckAgentSupervisor and RuntimeConfig reference old runtime patterns | Dead code / legacy coupling | 2 | Local |