import type { AgentName, CardType } from '../schemas/index.js';

export type PromptCardTypeKey = CardType | 'global';
export type PromptHostPolicy = 'global-agent' | 'workflow-agent' | 'process';
export interface PromptTemplateVariables { readonly [key: string]: string }
export interface PromptTemplateRegistry {
  render(cardType: PromptCardTypeKey, agentName: AgentName, variables: PromptTemplateVariables): string;
}
export interface PromptToolDisplay { readonly function: { readonly name: string; readonly description: string } }
export type CompiledPromptToken = Readonly<{ kind: 'literal'; text: string } | { kind: 'placeholder'; key: string }>;
export type CompiledPromptTemplate = Readonly<{ tokens: readonly CompiledPromptToken[] }>;
export type ResolvedPromptFragment = Readonly<{ path: string; text: string }>;
export type PromptFragmentResolver = (id: string) => ResolvedPromptFragment;

const PLACEHOLDERS: Readonly<Record<PromptHostPolicy, ReadonlySet<string>>> = Object.freeze({
  'global-agent': new Set(['toolList', 'vocabularySnippet', 'projectContext']),
  'workflow-agent': new Set(['cardId', 'cardTitle', 'cardBrief', 'cardType', 'contractDescription', 'toolList']),
  process: new Set(['cardType']),
});
const FRAGMENT_IDENTIFIER = /^[a-z][a-z0-9-]{0,63}$/u;

export class PromptTemplateRenderError extends Error {
  constructor(readonly cardType: PromptCardTypeKey, readonly templateName: string, readonly token: string, readonly reason: string) {
    super(`Prompt template error for ${cardType}/${templateName}: ${reason}: ${token}`);
    this.name = 'PromptTemplateRenderError';
  }
}

type ParsedToken = CompiledPromptToken | Readonly<{ kind: 'fragment'; id: string }>;
const pairKey = (cardType: PromptCardTypeKey, agentName: AgentName): string => `${cardType}/${agentName}`;
const malformedToken = (template: string, start: number): string => template.slice(start, Math.min(template.length, start + 32));
const identifierStart = (char: string | undefined): boolean => char !== undefined && /[A-Za-z_]/u.test(char);
const identifierPart = (char: string | undefined): boolean => char !== undefined && /[A-Za-z0-9_]/u.test(char);

function fail(cardType: PromptCardTypeKey, name: string, token: string, reason: string): never {
  throw new PromptTemplateRenderError(cardType, name, token, reason);
}

function parse(cardType: PromptCardTypeKey, name: string, template: string): readonly ParsedToken[] {
  const tokens: ParsedToken[] = [];
  let literal = '';
  let index = 0;
  const flush = () => { if (literal) { tokens.push(Object.freeze({ kind: 'literal', text: literal })); literal = ''; } };
  while (index < template.length) {
    if (template[index] === '{' && template[index + 1] === '{') {
      let cursor = index + 2;
      while (template[cursor] === ' ' || template[cursor] === '\t') cursor++;
      const fragment = template[cursor] === '>';
      if (fragment) { cursor++; while (template[cursor] === ' ' || template[cursor] === '\t') cursor++; }
      const start = cursor;
      if (fragment) {
        while (template[cursor] !== ' ' && template[cursor] !== '\t' && template[cursor] !== '}' && template[cursor] !== undefined) cursor++;
      } else {
        if (!identifierStart(template[cursor])) fail(cardType, name, malformedToken(template, index), 'invalid placeholder identifier');
        cursor++;
        while (identifierPart(template[cursor])) cursor++;
      }
      const id = template.slice(start, cursor);
      if (fragment && !FRAGMENT_IDENTIFIER.test(id)) fail(cardType, name, malformedToken(template, index), 'invalid fragment identifier');
      if (!fragment && template[cursor] !== ' ' && template[cursor] !== '\t' && template[cursor] !== '}' && template[cursor] !== undefined)
        fail(cardType, name, malformedToken(template, index), 'invalid placeholder identifier');
      while (template[cursor] === ' ' || template[cursor] === '\t') cursor++;
      if (template[cursor] !== '}' || template[cursor + 1] !== '}') {
        const reason = template[cursor] === '{' && template[cursor + 1] === '{' ? 'nested placeholder open before close' : 'unclosed placeholder';
        fail(cardType, name, malformedToken(template, index), reason);
      }
      flush();
      tokens.push(Object.freeze(fragment ? { kind: 'fragment', id } : { kind: 'placeholder', key: id }));
      index = cursor + 2;
      continue;
    }
    if (template[index] === '}' && template[index + 1] === '}') fail(cardType, name, '}}', "stray '}}'");
    literal += template[index++];
  }
  flush();
  return Object.freeze(tokens);
}

const OBSOLETE_PROCESS_DIRECTIVES: readonly RegExp[] = Object.freeze([
  /emit_result[^\n]*(?:\bstatus\b|\bdone\b[^\n]*\bblocked\b[^\n]*\bfailed\b)/i,
  /terminal statuses?[^\n]*(?:\bdone\b|\brework\b|\bblocked\b|\bfailed\b)/i,
  /report[^\n]*\bdone\b[^\n]*\bblocked\b[^\n]*\bfailed\b/i,
]);

export function compilePromptTemplate(options: Readonly<{
  cardType: PromptCardTypeKey; name: string; path: string; text: string; policy: PromptHostPolicy; resolveFragment: PromptFragmentResolver;
}>): CompiledPromptTemplate {
  if (!options.text.trim()) fail(options.cardType, options.name, options.path, 'empty template');
  const effective: CompiledPromptToken[] = [];
  for (const token of parse(options.cardType, options.name, options.text)) {
    if (token.kind !== 'fragment') { effective.push(token); continue; }
    const selected = options.resolveFragment(token.id);
    const fragmentTokens = parse(options.cardType, options.name, selected.text);
    if (fragmentTokens.some((candidate) => candidate.kind === 'fragment'))
      fail(options.cardType, options.name, options.path, `fragment '${token.id}' selected from '${selected.path}' contains a fragment include`);
    effective.push(...fragmentTokens as readonly CompiledPromptToken[]);
  }
  const allowed = PLACEHOLDERS[options.policy];
  for (const token of effective) if (token.kind === 'placeholder' && !allowed.has(token.key)) fail(options.cardType, options.name, token.key, 'unknown or inapplicable placeholder');
  if (options.policy === 'workflow-agent') {
    const count = effective.filter((token) => token.kind === 'placeholder' && token.key === 'contractDescription').length;
    if (count !== 1) fail(options.cardType, options.name, options.path, `effective workflow-agent template must contain {{contractDescription}} exactly once; found ${count}`);
    const reconstructed = effective.map((token) => token.kind === 'literal' ? token.text : `{{${token.key}}}`).join('');
    if (OBSOLETE_PROCESS_DIRECTIVES.some((pattern) => pattern.test(reconstructed))) fail(options.cardType, options.name, options.path, 'effective workflow-agent template contains an obsolete emit_result terminal directive');
  }
  return Object.freeze({ tokens: Object.freeze(effective) });
}

export function renderCompiledPrompt(cardType: PromptCardTypeKey, name: string, compiled: CompiledPromptTemplate, variables: PromptTemplateVariables): string {
  let output = '';
  for (const token of compiled.tokens) {
    if (token.kind === 'literal') output += token.text;
    else {
      if (!Object.prototype.hasOwnProperty.call(variables, token.key)) fail(cardType, name, token.key, 'missing variable');
      output += variables[token.key];
    }
  }
  return output;
}

type PromptArtifact = Readonly<{ compiled: CompiledPromptTemplate }>;
type RegistryWorkflows = Readonly<{
  analyst: Readonly<{ name: AgentName }>;
  analystPrompt: PromptArtifact;
  cardTypes: ReadonlyMap<CardType, Readonly<{ states: ReadonlyMap<string, Readonly<{ kind: string; agent?: Readonly<{ name: AgentName }>; selectedAgentPrompt?: PromptArtifact }>> }>>;
}>;

export function createPromptTemplateRegistry(workflows: RegistryWorkflows): PromptTemplateRegistry {
  const templates = new Map<string, CompiledPromptTemplate>();
  templates.set(pairKey('global', workflows.analyst.name), workflows.analystPrompt.compiled);
  for (const [cardType, workflow] of workflows.cardTypes) for (const node of workflow.states.values())
    if (node.kind === 'node' && node.agent && node.selectedAgentPrompt) templates.set(pairKey(cardType, node.agent.name), node.selectedAgentPrompt.compiled);
  const render = (cardType: PromptCardTypeKey, agentName: AgentName, variables: PromptTemplateVariables): string => {
    const compiled = templates.get(pairKey(cardType, agentName));
    if (!compiled) fail(cardType, agentName, pairKey(cardType, agentName), 'inactive prompt pair');
    return renderCompiledPrompt(cardType, agentName, compiled, variables);
  };
  return Object.freeze({ render });
}

export function formatPromptToolList(tools: readonly PromptToolDisplay[]): string {
  return tools.map((tool) => `- ${tool.function.name}: ${tool.function.description}`).join('\n');
}
