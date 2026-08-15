import type { RecordName } from '../schemas/index.js';

export type RecordDefinition=Readonly<{filename:RecordName;format:'markdown';schema:string;bootstrap:boolean;declared:boolean}>;
