import type { AgentName, CardTypeName } from '../schemas/index.js';

export type PromptHost =
  | Readonly<{ kind: 'global-agent' }>
  | Readonly<{ kind: 'workflow-agent'; cardType: CardTypeName }>
  | Readonly<{ kind: 'process'; cardType: CardTypeName }>;
export type AgentPromptHost = Extract<PromptHost, { kind: 'global-agent' | 'workflow-agent' }>;
export type ProcessPromptHost = Extract<PromptHost, { kind: 'process' }>;
export interface PromptTemplateVariables { readonly [key: string]: string }
export interface PromptTemplateRegistry {
  render(host: AgentPromptHost, agentName: AgentName, variables: PromptTemplateVariables): string;
}
export interface PromptToolDisplay { readonly function: { readonly name: string; readonly description: string } }
export type CompiledPromptToken = Readonly<{ kind: 'literal'; text: string } | { kind: 'placeholder'; key: string }>;
export type CompiledPromptTemplate = Readonly<{ tokens: readonly CompiledPromptToken[] }>;
export type ResolvedPromptFragment = Readonly<{ path: string; text: string }>;
export type PromptFragmentResolver = (id: string) => ResolvedPromptFragment;

const PLACEHOLDERS: Readonly<Record<PromptHost['kind'], ReadonlySet<string>>> = Object.freeze({
  'global-agent': new Set(['vocabularySnippet']),
  'workflow-agent': new Set(['contractDescription']),
  process: new Set(['cardType']),
});
const FRAGMENT_IDENTIFIER = /^[a-z][a-z0-9-]{0,63}$/u;
const hostContext = (host: PromptHost): string => host.kind === 'global-agent' ? host.kind : `${host.kind}:${host.cardType}`;

export class PromptTemplateRenderError extends Error {
  constructor(readonly host: PromptHost, readonly templateName: string, readonly token: string, readonly reason: string) {
    super(`Prompt template error for ${hostContext(host)}/${templateName}: ${reason}: ${token}`);
    this.name = 'PromptTemplateRenderError';
  }
}

type ParsedToken = CompiledPromptToken | Readonly<{ kind: 'fragment'; id: string }>;
const malformedToken = (template: string, start: number): string => template.slice(start, Math.min(template.length, start + 32));
const identifierStart = (char: string | undefined): boolean => char !== undefined && /[A-Za-z_]/u.test(char);
const identifierPart = (char: string | undefined): boolean => char !== undefined && /[A-Za-z0-9_]/u.test(char);

function fail(host: PromptHost, name: string, token: string, reason: string): never {
  throw new PromptTemplateRenderError(host, name, token, reason);
}

function parse(host: PromptHost, name: string, template: string): readonly ParsedToken[] {
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
        if (!identifierStart(template[cursor])) fail(host, name, malformedToken(template, index), 'invalid placeholder identifier');
        cursor++;
        while (identifierPart(template[cursor])) cursor++;
      }
      const id = template.slice(start, cursor);
      if (fragment && !FRAGMENT_IDENTIFIER.test(id)) fail(host, name, malformedToken(template, index), 'invalid fragment identifier');
      if (!fragment && template[cursor] !== ' ' && template[cursor] !== '\t' && template[cursor] !== '}' && template[cursor] !== undefined)
        fail(host, name, malformedToken(template, index), 'invalid placeholder identifier');
      while (template[cursor] === ' ' || template[cursor] === '\t') cursor++;
      if (template[cursor] !== '}' || template[cursor + 1] !== '}') {
        const reason = template[cursor] === '{' && template[cursor + 1] === '{' ? 'nested placeholder open before close' : 'unclosed placeholder';
        fail(host, name, malformedToken(template, index), reason);
      }
      flush();
      tokens.push(Object.freeze(fragment ? { kind: 'fragment', id } : { kind: 'placeholder', key: id }));
      index = cursor + 2;
      continue;
    }
    if (template[index] === '}' && template[index + 1] === '}') fail(host, name, '}}', "stray '}}'");
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
  host: PromptHost; name: string; path: string; text: string; resolveFragment: PromptFragmentResolver;
}>): CompiledPromptTemplate {
  if (!options.text.trim()) fail(options.host, options.name, options.path, 'empty template');
  const effective: CompiledPromptToken[] = [];
  for (const token of parse(options.host, options.name, options.text)) {
    if (token.kind !== 'fragment') { effective.push(token); continue; }
    const selected = options.resolveFragment(token.id);
    const fragmentTokens = parse(options.host, options.name, selected.text);
    if (fragmentTokens.some((candidate) => candidate.kind === 'fragment'))
      fail(options.host, options.name, options.path, `fragment '${token.id}' selected from '${selected.path}' contains a fragment include`);
    effective.push(...fragmentTokens as readonly CompiledPromptToken[]);
  }
  const allowed = PLACEHOLDERS[options.host.kind];
  for (const token of effective) if (token.kind === 'placeholder' && !allowed.has(token.key)) fail(options.host, options.name, token.key, 'unknown or inapplicable placeholder');
  if (options.host.kind === 'workflow-agent') {
    const count = effective.filter((token) => token.kind === 'placeholder' && token.key === 'contractDescription').length;
    if (count !== 1) fail(options.host, options.name, options.path, `effective workflow-agent template must contain {{contractDescription}} exactly once; found ${count}`);
    const reconstructed = effective.map((token) => token.kind === 'literal' ? token.text : `{{${token.key}}}`).join('');
    if (OBSOLETE_PROCESS_DIRECTIVES.some((pattern) => pattern.test(reconstructed))) fail(options.host, options.name, options.path, 'effective workflow-agent template contains an obsolete emit_result terminal directive');
  }
  return Object.freeze({ tokens: Object.freeze(effective) });
}

export function renderCompiledPrompt(host: PromptHost, name: string, compiled: CompiledPromptTemplate, variables: PromptTemplateVariables): string {
  let output = '';
  for (const token of compiled.tokens) {
    if (token.kind === 'literal') output += token.text;
    else {
      if (!Object.prototype.hasOwnProperty.call(variables, token.key)) fail(host, name, token.key, 'missing variable');
      output += variables[token.key];
    }
  }
  return output;
}

type PromptArtifact = Readonly<{ compiled: CompiledPromptTemplate }>;
type RegistryWorkflows = Readonly<{
  analyst: Readonly<{ name: AgentName }>;
  analystPrompt: PromptArtifact;
  cardTypes: ReadonlyMap<CardTypeName, Readonly<{ states: ReadonlyMap<string, Readonly<{ kind: string; agent?: Readonly<{ name: AgentName }>; selectedAgentPrompt?: PromptArtifact }>> }>>;
}>;

export function createPromptTemplateRegistry(workflows: RegistryWorkflows): PromptTemplateRegistry {
  const workflowTemplates = new Map<CardTypeName, ReadonlyMap<AgentName, CompiledPromptTemplate>>();
  for (const [cardType, workflow] of workflows.cardTypes) {
    const templates = new Map<AgentName, CompiledPromptTemplate>();
    for (const node of workflow.states.values()) if (node.kind === 'node' && node.agent && node.selectedAgentPrompt) templates.set(node.agent.name, node.selectedAgentPrompt.compiled);
    workflowTemplates.set(cardType, templates);
  }
  return Object.freeze({
    render(host: AgentPromptHost, agentName: AgentName, variables: PromptTemplateVariables): string {
      const compiled = host.kind === 'global-agent'
        ? agentName === workflows.analyst.name ? workflows.analystPrompt.compiled : undefined
        : workflowTemplates.get(host.cardType)?.get(agentName);
      if (!compiled) fail(host, agentName, agentName, 'inactive prompt pair');
      return renderCompiledPrompt(host, agentName, compiled, variables);
    },
  });
}

export function formatPromptToolList(tools: readonly PromptToolDisplay[]): string {
  return tools.map((tool) => `- ${tool.function.name}: ${tool.function.description}`).join('\n');
}
