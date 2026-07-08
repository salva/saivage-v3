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

type PromptCardTypeGuidanceConfig = Readonly<Record<string, string>> & Readonly<{ default: string }>;

export interface PromptDefaultBundle {
  readonly planner: string;
  readonly executor: string;
  readonly reviewer: string;
  readonly analyst: string;
  readonly cardTypeGuidance: PromptCardTypeGuidanceConfig;
}

export interface PromptTemplateRegistryOptions {
  promptsConfig?: PromptTemplatesConfig;
  /** @internal Test fixture input; runtime callers rely on shipped defaults. */
  defaultBundleForTest?: PromptDefaultBundle;
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
  planner: new Set(['cardId', 'cardTitle', 'cardBrief', 'contractDescription', 'toolList']),
  executor: new Set(['cardId', 'cardTitle', 'cardBrief', 'contractDescription', 'toolList', 'cardType', 'cardTypeGuidance']),
  reviewer: new Set(['cardId', 'cardTitle', 'cardBrief', 'assessmentId', 'contractDescription', 'toolList']),
  analyst: new Set(['toolList', 'vocabularySnippet', 'projectContext']),
};

const GUIDANCE_ALLOWED_PLACEHOLDERS = new Set(['cardType']);

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

function readDefaultBundle(): PromptDefaultBundle {
  const path = defaultsPath();
  if (!existsSync(path)) {
    throw new Error(`Default prompt template file is missing: ${path}`);
  }

  const parsed = YAML.parse(readFileSync(path, 'utf8')) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Default prompt template file must contain a mapping: ${path}`);
  }

  return validateDefaultBundle(parsed as Record<string, unknown>, `Default prompt template file ${path}`);
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

function validateGuidancePlaceholders(key: string, value: string): void {
  const tokens = tokenizeTemplate('executor', value);
  for (const token of tokens) {
    if (token.kind === 'placeholder' && !GUIDANCE_ALLOWED_PLACEHOLDERS.has(token.key)) {
      throw new PromptTemplateRenderError('executor', token.key, `unknown cardTypeGuidance placeholder in ${key}`);
    }
  }
}

function validateDefaultBundle(raw: Record<string, unknown>, source: string): PromptDefaultBundle {
  const templates = {} as Record<AgentRoleKey, string>;
  for (const role of ROLE_KEYS) {
    const value = raw[role];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`${source} is missing non-empty ${role} template.`);
    }
    templates[role] = value;
  }

  const rawGuidance = raw.cardTypeGuidance;
  if (rawGuidance === null || typeof rawGuidance !== 'object' || Array.isArray(rawGuidance)) {
    throw new Error(`${source} must contain a cardTypeGuidance mapping.`);
  }
  const guidance = rawGuidance as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(guidance)) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`${source} cardTypeGuidance.${key} must be a non-empty string.`);
    }
    validateGuidancePlaceholders(key, value);
    result[key] = value;
  }
  if (typeof result.default !== 'string' || result.default.length === 0) {
    throw new Error(`${source} cardTypeGuidance.default must be a non-empty string.`);
  }
  return Object.freeze({ ...templates, cardTypeGuidance: Object.freeze(result) as PromptCardTypeGuidanceConfig });
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
  const defaults = validateDefaultBundle((options.defaultBundleForTest ?? readDefaultBundle()) as unknown as Record<string, unknown>, 'Prompt default bundle');
  const tokensByRole = new Map<AgentRoleKey, readonly TemplateToken[]>();
  let executorTemplateIncludesCardTypeGuidance = false;

  for (const role of ROLE_KEYS) {
    const override = options.promptsConfig?.[role];
    const template = override ?? defaults[role];
    if (typeof template !== 'string' || template.length === 0) {
      throw new PromptTemplateRenderError(role, String(template), 'empty template');
    }
    const tokens = tokenizeTemplate(role, template);
    validatePlaceholders(role, tokens);
    tokensByRole.set(role, tokens);
    if (role === 'executor') {
      executorTemplateIncludesCardTypeGuidance = tokens.some((token) => token.kind === 'placeholder' && token.key === 'cardTypeGuidance');
    }
  }

  return Object.freeze({
    render(role: AgentRoleKey, variables: PromptTemplateVariables): string {
      const tokens = tokensByRole.get(role);
      if (tokens === undefined) {
        throw new PromptTemplateRenderError(role, role, 'unknown role');
      }
      const renderVariables = role === 'executor' && executorTemplateIncludesCardTypeGuidance
        ? { ...variables, cardTypeGuidance: renderCardTypeGuidance(defaults.cardTypeGuidance, variables.cardType) }
        : variables;
      return renderTokens(role, tokens, renderVariables);
    },
  });
}

function renderCardTypeGuidance(guidance: PromptCardTypeGuidanceConfig, cardType: string | undefined): string {
  if (!cardType) return '';
  const template = guidance[cardType] ?? guidance.default;
  return renderTokens('executor', tokenizeTemplate('executor', template), { cardType });
}

export function formatPromptToolList(tools: readonly PromptToolDisplay[]): string {
  return tools.map((tool) => `- ${tool.function.name}: ${tool.function.description}`).join('\n');
}
