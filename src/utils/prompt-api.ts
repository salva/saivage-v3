import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as YAML from 'yaml';

export type AgentRoleKey = 'planner' | 'executor' | 'reviewer' | 'analyst';

export interface PromptTemplateVariables {
  readonly [key: string]: string;
}

export interface PromptTemplateRegistry {
  render(role: AgentRoleKey, variables: PromptTemplateVariables): string;
}

export type PromptTemplatesConfig = Partial<Record<AgentRoleKey, string>>;

export interface PromptTemplateRegistryOptions {
  projectRoot: string;
  promptsConfig?: PromptTemplatesConfig;
  /** @internal Test fixture input; runtime callers rely on shipped defaults. */
  defaultTemplatesForTest?: PromptTemplatesConfig;
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

const ROLE_KEYS = ['planner', 'executor', 'reviewer', 'analyst'] as const satisfies readonly AgentRoleKey[];

const ALLOWED_PLACEHOLDERS: Readonly<Record<AgentRoleKey, ReadonlySet<string>>> = {
  planner: new Set(['cardId', 'cardTitle', 'cardBrief', 'contractDescription', 'toolList', 'goalDepth', 'maxDepth', 'skills']),
  executor: new Set(['cardId', 'cardTitle', 'cardBrief', 'contractDescription', 'toolList', 'cardType', 'cardTypeGuidance', 'skills']),
  reviewer: new Set(['cardId', 'cardTitle', 'cardBrief', 'assessmentId', 'contractDescription', 'toolList', 'skills']),
  analyst: new Set(['toolList', 'vocabularySnippet', 'projectContext', 'skills']),
};

export class PromptTemplateRenderError extends Error {
  constructor(
    readonly role: AgentRoleKey,
    readonly token: string,
    readonly reason: string,
  ) {
    super(`Prompt template error for ${role}: ${reason}: ${token}`);
    this.name = 'PromptTemplateRenderError';
  }
}

function defaultsPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'prompt-defaults.yaml');
}

function readDefaultTemplates(): Record<AgentRoleKey, string> {
  const path = defaultsPath();
  if (!existsSync(path)) {
    throw new Error(`Default prompt template file is missing: ${path}`);
  }

  const parsed = YAML.parse(readFileSync(path, 'utf8')) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Default prompt template file must contain a mapping: ${path}`);
  }

  const defaults = parsed as Record<string, unknown>;
  const result = {} as Record<AgentRoleKey, string>;
  for (const role of ROLE_KEYS) {
    const value = defaults[role];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`Default prompt template file is missing non-empty ${role} template: ${path}`);
    }
    result[role] = value;
  }
  return result;
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

function throwMalformed(role: AgentRoleKey, token: string, reason: string): never {
  throw new PromptTemplateRenderError(role, token, reason);
}

function malformedToken(template: string, start: number): string {
  return template.slice(start, Math.min(template.length, start + 32));
}

function tokenizeTemplate(role: AgentRoleKey, template: string): readonly TemplateToken[] {
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
        throwMalformed(role, malformedToken(template, i), 'invalid placeholder identifier');
      }
      j++;
      while (isIdentifierPart(template[j])) j++;
      const key = template.slice(idStart, j);

      if (template[j] !== ' ' && template[j] !== '\t' && template[j] !== '}' && template[j] !== undefined) {
        throwMalformed(role, malformedToken(template, i), 'invalid placeholder identifier');
      }
      while (template[j] === ' ' || template[j] === '\t') j++;
      if (template[j] !== '}' || template[j + 1] !== '}') {
        const reason = template[j] === '{' && template[j + 1] === '{' ? 'nested placeholder open before close'
          : isIdentifierStart(template[j]) ? 'invalid placeholder identifier'
          : 'unclosed placeholder';
        throwMalformed(role, malformedToken(template, i), reason);
      }

      flush();
      tokens.push({ kind: 'placeholder', key });
      i = j + 2;
      continue;
    }

    if (c === '}' && template[i + 1] === '}') {
      throwMalformed(role, '}}', "stray '}}'");
    }

    buffer += c;
    i++;
  }

  flush();
  return Object.freeze(tokens);
}

function validatePlaceholders(role: AgentRoleKey, tokens: readonly TemplateToken[]): void {
  const allowed = ALLOWED_PLACEHOLDERS[role];
  for (const token of tokens) {
    if (token.kind === 'placeholder' && !allowed.has(token.key)) {
      throw new PromptTemplateRenderError(role, token.key, 'unknown placeholder');
    }
  }
}

function renderTokens(role: AgentRoleKey, tokens: readonly TemplateToken[], variables: PromptTemplateVariables): string {
  let output = '';
  for (const token of tokens) {
    if (token.kind === 'literal') {
      output += token.text;
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(variables, token.key)) {
      throw new PromptTemplateRenderError(role, token.key, 'missing variable');
    }
    output += variables[token.key];
  }
  return output;
}

export function createPromptTemplateRegistry(options: PromptTemplateRegistryOptions): PromptTemplateRegistry {
  void options.projectRoot;
  const defaults = options.defaultTemplatesForTest ?? readDefaultTemplates();
  const tokensByRole = new Map<AgentRoleKey, readonly TemplateToken[]>();

  for (const role of ROLE_KEYS) {
    const override = options.promptsConfig?.[role];
    const template = override ?? defaults[role];
    if (typeof template !== 'string' || template.length === 0) {
      throw new PromptTemplateRenderError(role, String(template), 'empty template');
    }
    const tokens = tokenizeTemplate(role, template);
    validatePlaceholders(role, tokens);
    tokensByRole.set(role, tokens);
  }

  return Object.freeze({
    render(role: AgentRoleKey, variables: PromptTemplateVariables): string {
      const tokens = tokensByRole.get(role);
      if (tokens === undefined) {
        throw new PromptTemplateRenderError(role, role, 'unknown role');
      }
      return renderTokens(role, tokens, variables);
    },
  });
}

export function formatPromptToolList(tools: readonly PromptToolDisplay[]): string {
  return tools.map((tool) => `- ${tool.function.name}: ${tool.function.description}`).join('\n');
}

export function executorTypeGuidance(cardType?: string): string {
  if (!cardType) return '';

  switch (cardType) {
    case 'code':
      return `- This is a **code** card — write, modify, or refactor source code.
- Run tests and linters after making changes.
- Summarize new or modified project files in result metadata.`;
    case 'test':
      return `- This is a **test** card — write or update tests.
- Aim for meaningful coverage.
- Run the new tests to confirm they pass.`;
    case 'doc':
      return `- This is a **documentation** card — write or update documentation.
- Ensure links and references are valid.`;
    case 'data':
      return `- This is a **data** card — fetch, process, or transform data.
- Validate format and structure after processing.`;
    case 'research':
      return `- This is a **research** card — investigate and report findings.
- Summarize findings clearly.`;
    case 'architecture':
      return `- This is an **architecture** card — design or review system structure.
- Document decisions and trade-offs.`;
    case 'ops':
      return `- This is an **ops** card — perform operational tasks.
- Log command outputs for auditing.`;
    default:
      return `- Card type \`${cardType}\` — follow the general executor guidelines.`;
  }
}
