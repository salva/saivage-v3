import type { AgentName,RecordName } from '../schemas/index.js';

export type RecordDefinition=Readonly<{filename:RecordName;writers:readonly AgentName[];format:'markdown';schema:string;bootstrap:boolean}>;
