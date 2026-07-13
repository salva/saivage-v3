import { PlanningCardProcessorActor as ProductionPlanningCardProcessorActor } from '../../src/runtime/actors/planning-card-processor-actor.js';
import { TerminalCardProcessorActor as ProductionTerminalCardProcessorActor } from '../../src/runtime/actors/terminal-card-processor-actor.js';
import { testAppLogs } from './app-logs.js';

type PlanningArgs = ConstructorParameters<typeof ProductionPlanningCardProcessorActor>[0];
type TerminalArgs = ConstructorParameters<typeof ProductionTerminalCardProcessorActor>[0];

export class TestPlanningCardProcessorActor extends ProductionPlanningCardProcessorActor {
  constructor(args: Omit<PlanningArgs, 'appLogs'> & Partial<Pick<PlanningArgs, 'appLogs'>>) { super({ ...args, appLogs: args.appLogs ?? testAppLogs(args.projectRoot) }); }
}

export class TestTerminalCardProcessorActor extends ProductionTerminalCardProcessorActor {
  constructor(args: Omit<TerminalArgs, 'appLogs'> & Partial<Pick<TerminalArgs, 'appLogs'>>) { super({ ...args, appLogs: args.appLogs ?? testAppLogs(args.projectRoot) }); }
}
