import type { AgentName, CardType } from '../schemas/index.js';
import type { CompiledAgentPrompt, CompiledProjectWorkflows } from '../runtime/card-process/card-process-config.js';

export type PromptCardTypeKey = CardType | 'global';

export interface PromptTemplateVariables {
  readonly [key: string]: string;
}

export interface PromptTemplateRegistry {
  render(cardType: PromptCardTypeKey, agentName: AgentName, variables: PromptTemplateVariables): string;
}

export interface ProcessAgentPromptTemplateRegistry extends PromptTemplateRegistry {
  validateProcessNode(cardType: CardType, agentName: AgentName, variables: PromptTemplateVariables): string;
}

export interface PromptToolDisplay {
  readonly function: {
    readonly name: string;
    readonly description: string;
  };
}

type TemplateToken =
  | { readonly kind: 'literal'; readonly text: string }
  | { readonly kind: 'placeholder'; readonly key: string };

const ALLOWED_PLACEHOLDERS = new Set(['cardId','cardTitle','cardBrief','contractDescription','toolList','cardType','vocabularySnippet','projectContext']);

export class PromptTemplateRenderError extends Error {
  constructor(
    readonly cardType: PromptCardTypeKey,
    readonly agentName: AgentName,
    readonly token: string,
    readonly reason: string,
  ) {
    super(`Prompt template error for ${cardType}/${agentName}: ${reason}: ${token}`);
    this.name = 'PromptTemplateRenderError';
  }
}

function pairKey(cardType: PromptCardTypeKey, agentName: AgentName): string {
  return `${cardType}/${agentName}`;
}

function isIdentifierStart(char: string | undefined): boolean {
  if (char === undefined) return false;
  const code = char.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || char === '_';
}

function isIdentifierPart(char: string | undefined): boolean {
  if (char === undefined) return false;
  const code = char.charCodeAt(0);
  return isIdentifierStart(char) || (code >= 48 && code <= 57);
}

function throwMalformed(cardType: PromptCardTypeKey, agentName: AgentName, token: string, reason: string): never {
  throw new PromptTemplateRenderError(cardType, agentName, token, reason);
}

function malformedToken(template: string, start: number): string {
  return template.slice(start, Math.min(template.length, start + 32));
}

function tokenizeTemplate(cardType: PromptCardTypeKey, agentName: AgentName, template: string): readonly TemplateToken[] {
  const tokens: TemplateToken[] = [];
  let buffer = '';
  let i = 0;
  const flush = () => {
    if (buffer.length > 0) {
      tokens.push({ kind: 'literal', text: buffer });
      buffer = '';
    }
  };

  while (i < template.length) {
    const c = template[i];
    if (c === '{' && template[i + 1] === '{') {
      let j = i + 2;
      while (template[j] === ' ' || template[j] === '\t') j++;

      const idStart = j;
      if (!isIdentifierStart(template[j])) {
        throwMalformed(cardType, agentName, malformedToken(template, i), 'invalid placeholder identifier');
      }
      j++;
      while (isIdentifierPart(template[j])) j++;
      const key = template.slice(idStart, j);

      if (template[j] !== ' ' && template[j] !== '\t' && template[j] !== '}' && template[j] !== undefined) {
        throwMalformed(cardType, agentName, malformedToken(template, i), 'invalid placeholder identifier');
      }
      while (template[j] === ' ' || template[j] === '\t') j++;
      if (template[j] !== '}' || template[j + 1] !== '}') {
        const reason = template[j] === '{' && template[j + 1] === '{' ? 'nested placeholder open before close'
          : isIdentifierStart(template[j]) ? 'invalid placeholder identifier'
          : 'unclosed placeholder';
        throwMalformed(cardType, agentName, malformedToken(template, i), reason);
      }

      flush();
      tokens.push({ kind: 'placeholder', key });
      i = j + 2;
      continue;
    }

    if (c === '}' && template[i + 1] === '}') {
      throwMalformed(cardType, agentName, '}}', "stray '}}'");
    }

    buffer += c;
    i++;
  }

  flush();
  return Object.freeze(tokens);
}

function validatePlaceholders(cardType: PromptCardTypeKey, agentName: AgentName, tokens: readonly TemplateToken[]): void {
  for (const token of tokens) {
    if (token.kind === 'placeholder' && !ALLOWED_PLACEHOLDERS.has(token.key)) {
      throw new PromptTemplateRenderError(cardType, agentName, token.key, 'unknown placeholder');
    }
  }
}

function renderTokens(cardType: PromptCardTypeKey, agentName: AgentName, tokens: readonly TemplateToken[], variables: PromptTemplateVariables): string {
  let output = '';
  for (const token of tokens) {
    if (token.kind === 'literal') {
      output += token.text;
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(variables, token.key)) {
      throw new PromptTemplateRenderError(cardType, agentName, token.key, 'missing variable');
    }
    output += variables[token.key];
  }
  return output;
}

const OBSOLETE_PROCESS_DIRECTIVES: readonly RegExp[] = Object.freeze([
  /emit_result[^\n]*(?:\bstatus\b|\bdone\b[^\n]*\bblocked\b[^\n]*\bfailed\b)/i,
  /terminal statuses?[^\n]*(?:\bdone\b|\brework\b|\bblocked\b|\bfailed\b)/i,
  /report[^\n]*\bdone\b[^\n]*\bblocked\b[^\n]*\bfailed\b/i,
]);

function validateProcessTemplate(cardType: PromptCardTypeKey, agentName: AgentName, path: string, template: string, tokens: readonly TemplateToken[]): void {
  const contractCount = tokens.filter((token) => token.kind === 'placeholder' && token.key === 'contractDescription').length;
  if (contractCount !== 1) throw new PromptTemplateRenderError(cardType, agentName, path, `effective process-agent template must contain {{contractDescription}} exactly once; found ${contractCount}`);
  if (OBSOLETE_PROCESS_DIRECTIVES.some((pattern) => pattern.test(template))) {
    throw new PromptTemplateRenderError(cardType, agentName, path, 'effective process-agent template contains an obsolete emit_result terminal directive');
  }
}

export function validateCompiledAgentPrompt(cardType: PromptCardTypeKey, agentName: AgentName, prompt: CompiledAgentPrompt, processAgent: boolean): void {
  if (prompt.text.trim().length === 0) throw new PromptTemplateRenderError(cardType, agentName, prompt.path, 'empty template');
  const tokens = tokenizeTemplate(cardType, agentName, prompt.text);
  validatePlaceholders(cardType, agentName, tokens);
  if (processAgent) validateProcessTemplate(cardType, agentName, prompt.path, prompt.text, tokens);
}

export function createPromptTemplateRegistry(workflows:CompiledProjectWorkflows): ProcessAgentPromptTemplateRegistry {
  const templatesByPair = new Map<string, { readonly path: string; readonly template: string; readonly tokens: readonly TemplateToken[] }>();
  const references:Array<{cardType:PromptCardTypeKey;agentName:AgentName;prompt:CompiledAgentPrompt}>=[{cardType:'global',agentName:workflows.analyst.name,prompt:workflows.analystPrompt}];
  for(const[cardType,workflow]of workflows.cardTypes)for(const node of workflow.nodes.values())references.push({cardType,agentName:node.agent.name,prompt:node.selectedAgentPrompt});
  for (const {cardType,agentName,prompt} of references) {
    const {path,text:template}=prompt;
    const tokens = tokenizeTemplate(cardType, agentName, template);
    validatePlaceholders(cardType, agentName, tokens);
    templatesByPair.set(pairKey(cardType, agentName), Object.freeze({ path, template, tokens }));
  }

  return Object.freeze({
    render(cardType: PromptCardTypeKey, agentName: AgentName, variables: PromptTemplateVariables): string {
      const effective = templatesByPair.get(pairKey(cardType, agentName));
      if (effective === undefined) {
        throw new PromptTemplateRenderError(cardType, agentName, pairKey(cardType, agentName), 'inactive prompt pair');
      }
      return renderTokens(cardType, agentName, effective.tokens, variables);
    },
    validateProcessNode(cardType: CardType, agentName: AgentName, variables: PromptTemplateVariables): string {
      const effective = templatesByPair.get(pairKey(cardType, agentName));
      if (effective === undefined) throw new PromptTemplateRenderError(cardType, agentName, pairKey(cardType, agentName), 'inactive prompt pair');
      validateProcessTemplate(cardType, agentName, effective.path, effective.template, effective.tokens);
      return renderTokens(cardType, agentName, effective.tokens, variables);
    },
  });
}

export function formatPromptToolList(tools: readonly PromptToolDisplay[]): string {
  return tools.map((tool) => `- ${tool.function.name}: ${tool.function.description}`).join('\n');
}
