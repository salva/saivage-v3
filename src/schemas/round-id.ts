export type RoundKind = 'pre' | 'user' | 'assistant' | 'compacted';

export const roundIdGrammar = /^r-(?:pre|user|assistant|compacted)-[0-9a-f]{32}$/;
