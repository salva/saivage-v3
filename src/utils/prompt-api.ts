import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activePromptPairs, type PromptCardTypeKey, type PromptRoleKey } from '../schemas/index.js';

export type AgentRoleKey = PromptRoleKey;
export type { PromptCardTypeKey } from '../schemas/index.js';

export interface PromptTemplateVariables {
  readonly [key: string]: string;
}

export interface PromptTemplateRegistry {
  render(cardType: PromptCardTypeKey, role: AgentRoleKey, variables: PromptTemplateVariables): string;
}

export interface PromptTemplateRegistryOptions {
  defaultRoot?: string;
  overrideRoot?: string;
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

const ALLOWED_PLACEHOLDERS: Readonly<Record<AgentRoleKey, ReadonlySet<string>>> = {
  planner: new Set(['cardId', 'cardTitle', 'cardBrief', 'contractDescription', 'toolList']),
  executor: new Set(['cardId', 'cardTitle', 'cardBrief', 'contractDescription', 'toolList', 'cardType']),
  reviewer: new Set(['cardId', 'cardTitle', 'cardBrief', 'contractDescription', 'toolList']),
  analyst: new Set(['toolList', 'vocabularySnippet', 'projectContext']),
};

export class PromptTemplateRenderError extends Error {
  constructor(
    readonly cardType: PromptCardTypeKey,
    readonly role: AgentRoleKey,
    readonly token: string,
    readonly reason: string,
  ) {
    super(`Prompt template error for ${cardType}/${role}: ${reason}: ${token}`);
    this.name = 'PromptTemplateRenderError';
  }
}

function bundledDefaultsRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'prompts');
}

function pairKey(cardType: PromptCardTypeKey, role: AgentRoleKey): string {
  return `${cardType}/${role}`;
}

function promptPath(root: string, cardType: PromptCardTypeKey, role: AgentRoleKey): string {
  return join(root, cardType, `${role}.md`);
}

function effectiveTemplatePath(defaultRoot: string, overrideRoot: string | undefined, cardType: PromptCardTypeKey, role: AgentRoleKey): string {
  const overridePath = overrideRoot === undefined ? undefined : promptPath(overrideRoot, cardType, role);
  if (overridePath !== undefined && existsSync(overridePath)) return overridePath;
  const defaultPath = promptPath(defaultRoot, cardType, role);
  if (existsSync(defaultPath)) return defaultPath;
  throw new PromptTemplateRenderError(cardType, role, `${cardType}/${role}.md`, 'missing effective template');
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

function throwMalformed(cardType: PromptCardTypeKey, role: AgentRoleKey, token: string, reason: string): never {
  throw new PromptTemplateRenderError(cardType, role, token, reason);
}

function malformedToken(template: string, start: number): string {
  return template.slice(start, Math.min(template.length, start + 32));
}

function tokenizeTemplate(cardType: PromptCardTypeKey, role: AgentRoleKey, template: string): readonly TemplateToken[] {
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
        throwMalformed(cardType, role, malformedToken(template, i), 'invalid placeholder identifier');
      }
      j++;
      while (isIdentifierPart(template[j])) j++;
      const key = template.slice(idStart, j);

      if (template[j] !== ' ' && template[j] !== '\t' && template[j] !== '}' && template[j] !== undefined) {
        throwMalformed(cardType, role, malformedToken(template, i), 'invalid placeholder identifier');
      }
      while (template[j] === ' ' || template[j] === '\t') j++;
      if (template[j] !== '}' || template[j + 1] !== '}') {
        const reason = template[j] === '{' && template[j + 1] === '{' ? 'nested placeholder open before close'
          : isIdentifierStart(template[j]) ? 'invalid placeholder identifier'
          : 'unclosed placeholder';
        throwMalformed(cardType, role, malformedToken(template, i), reason);
      }

      flush();
      tokens.push({ kind: 'placeholder', key });
      i = j + 2;
      continue;
    }

    if (c === '}' && template[i + 1] === '}') {
      throwMalformed(cardType, role, '}}', "stray '}}'");
    }

    buffer += c;
    i++;
  }

  flush();
  return Object.freeze(tokens);
}

function validatePlaceholders(cardType: PromptCardTypeKey, role: AgentRoleKey, tokens: readonly TemplateToken[]): void {
  const allowed = ALLOWED_PLACEHOLDERS[role];
  for (const token of tokens) {
    if (token.kind === 'placeholder' && !allowed.has(token.key)) {
      throw new PromptTemplateRenderError(cardType, role, token.key, 'unknown placeholder');
    }
  }
}

function renderTokens(cardType: PromptCardTypeKey, role: AgentRoleKey, tokens: readonly TemplateToken[], variables: PromptTemplateVariables): string {
  let output = '';
  for (const token of tokens) {
    if (token.kind === 'literal') {
      output += token.text;
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(variables, token.key)) {
      throw new PromptTemplateRenderError(cardType, role, token.key, 'missing variable');
    }
    output += variables[token.key];
  }
  return output;
}

export function createPromptTemplateRegistry(options: PromptTemplateRegistryOptions = {}): PromptTemplateRegistry {
  const defaultRoot = options.defaultRoot ?? bundledDefaultsRoot();
  const tokensByPair = new Map<string, readonly TemplateToken[]>();

  for (const [cardType, role] of activePromptPairs) {
    const path = effectiveTemplatePath(defaultRoot, options.overrideRoot, cardType, role);
    const template = readFileSync(path, 'utf8');
    if (template.length === 0) {
      throw new PromptTemplateRenderError(cardType, role, path, 'empty template');
    }
    const tokens = tokenizeTemplate(cardType, role, template);
    validatePlaceholders(cardType, role, tokens);
    tokensByPair.set(pairKey(cardType, role), tokens);
  }

  return Object.freeze({
    render(cardType: PromptCardTypeKey, role: AgentRoleKey, variables: PromptTemplateVariables): string {
      const tokens = tokensByPair.get(pairKey(cardType, role));
      if (tokens === undefined) {
        throw new PromptTemplateRenderError(cardType, role, pairKey(cardType, role), 'inactive prompt pair');
      }
      return renderTokens(cardType, role, tokens, variables);
    },
  });
}

export function formatPromptToolList(tools: readonly PromptToolDisplay[]): string {
  return tools.map((tool) => `- ${tool.function.name}: ${tool.function.description}`).join('\n');
}
