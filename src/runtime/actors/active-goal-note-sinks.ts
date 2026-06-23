export interface GoalNote {
  id: string;
  content: string;
}

export interface GoalNoteSink {
  addNote(note: GoalNote): void;
}

export class ActiveGoalNoteSinks {
  private readonly byGoalId = new Map<string, GoalNoteSink>();

  register(goalId: string, sink: GoalNoteSink): void {
    this.byGoalId.set(goalId, sink);
  }

  unregister(goalId: string, sink: GoalNoteSink): void {
    if (this.byGoalId.get(goalId) === sink) this.byGoalId.delete(goalId);
  }

  addNote(goalId: string, note: GoalNote): boolean {
    const sink = this.byGoalId.get(goalId);
    if (!sink) return false;
    sink.addNote(note);
    return true;
  }

  clear(): void {
    this.byGoalId.clear();
  }
}

const registries = new Map<string, ActiveGoalNoteSinks>();

export function getActiveGoalNoteSinks(projectRoot: string): ActiveGoalNoteSinks {
  let registry = registries.get(projectRoot);
  if (!registry) {
    registry = new ActiveGoalNoteSinks();
    registries.set(projectRoot, registry);
  }
  return registry;
}

export function clearActiveGoalNoteSinks(projectRoot: string): void {
  registries.get(projectRoot)?.clear();
  registries.delete(projectRoot);
}
