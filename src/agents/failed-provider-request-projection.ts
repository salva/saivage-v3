import {
  isSecretKey,
  projectDynamicForOutbound,
  redactTextForOutbound,
} from '../redaction/index.js';

export function diagnosticProjectionCounts() {
  return {
    structured_private: 0,
    images: 0,
    private_replay: 0,
    data_urls: 0,
    tool_arguments_reencoded: 0,
    unprojectable_tool_arguments: 0,
    text_redactions: 0,
    structured_redactions: 0,
  };
}

/** Projects captured wire JSON only; native discriminators have authority only at protocol positions. */
export function projectFailedProviderRequest(
  serialized: string,
  protocol: string,
  credential: string | undefined,
  counts: ReturnType<typeof diagnosticProjectionCounts>,
): string {
  const privateReplay = () => {
    counts.private_replay++;
    return '[OMITTED_PRIVATE_REPLAY]';
  };
  const image = () => {
    counts.images++;
    return '[OMITTED_IMAGE]';
  };
  const text = (value: string): string => {
    const withoutData = value.replace(/data:[^\s"'<>]*;base64,[A-Za-z0-9+/=]+/gi, () => {
      counts.data_urls++;
      return '[OMITTED_DATA_URL]';
    });
    const safe = redactTextForOutbound(
      credential ? withoutData.split(credential).join('[REDACTED]') : withoutData,
    );
    if (safe !== withoutData) counts.text_redactions++;
    return safe;
  };
  const ordinary = (value: unknown): unknown => {
    if (typeof value === 'string') return text(value);
    if (Array.isArray(value)) return value.map(ordinary);
    if (value === null || typeof value !== 'object') return value;
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const storedKey = text(key);
      if (
        isSecretKey(key) ||
        /(?:^|[_-])(?:auth(?:entication|orization)?(?:[_-]?profiles?)?|headers?|cookies?|env(?:ironment)?|config(?:uration)?)$/.test(
          key.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase(),
        )
      ) {
        counts.structured_private++;
        const safe = projectDynamicForOutbound({
          [storedKey]: '[OMITTED_PRIVATE_FIELD]',
        }) as Record<string, unknown>;
        if (safe[storedKey] !== '[OMITTED_PRIVATE_FIELD]') counts.structured_redactions++;
        output[storedKey] = safe[storedKey];
      } else if (/^(?:image_url|image_data|b64_json|base64)$/i.test(key))
        output[storedKey] = image();
      else output[storedKey] = ordinary(child);
    }
    return output;
  };
  const argumentsValue = (value: unknown): unknown => {
    const omitted = () => {
      counts.unprojectable_tool_arguments++;
      return '[OMITTED_TOOL_ARGUMENTS]';
    };
    if (typeof value !== 'string') return omitted();
    let decoded: unknown;
    try {
      decoded = JSON.parse(value);
    } catch {
      return omitted();
    }
    const projected = JSON.stringify(ordinary(decoded));
    counts.tool_arguments_reencoded++;
    return projected;
  };
  type Fields = Record<string, (value: unknown) => unknown>;
  const scalar = (value: unknown) => (typeof value === 'string' ? text(value) : privateReplay());
  // Unknown keys are never echoed. The fixed marker cannot collide with any visible field.
  const visible = (object: Record<string, unknown>, fields: Fields): unknown => {
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(object)) {
      if (Object.hasOwn(fields, key)) output[key] = fields[key]!(value);
      else {
        privateReplay();
        output._diagnostic_omitted_extensions = '[OMITTED_PRIVATE_REPLAY]';
      }
    }
    return output;
  };
  const objectValue = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  const content = (value: unknown, chat = false): unknown => {
    if (!objectValue(value)) return privateReplay();
    if (['input_image', 'image_url', 'image'].includes(value.type as string)) return image();
    if (value.type === (chat ? 'text' : 'input_text') || (!chat && value.type === 'output_text'))
      return visible(value, { type: scalar, text: scalar });
    if (!chat && value.type === 'refusal') return visible(value, { type: scalar, refusal: scalar });
    return privateReplay();
  };
  const messageContent = (value: unknown, chat = false): unknown =>
    typeof value === 'string'
      ? text(value)
      : Array.isArray(value)
        ? value.map((block) => content(block, chat))
        : privateReplay();
  const responsesItem = (value: unknown): unknown => {
    if (!objectValue(value)) return privateReplay();
    if (
      value.type === 'message' ||
      (value.type === undefined && typeof value.role === 'string' && 'content' in value)
    )
      return visible(value, {
        type: scalar,
        role: scalar,
        status: scalar,
        content: (value) => messageContent(value),
      });
    if (value.type === 'function_call')
      return visible(value, {
        type: scalar,
        status: scalar,
        name: scalar,
        call_id: scalar,
        arguments: argumentsValue,
      });
    if (value.type === 'function_call_output')
      return visible(value, {
        type: scalar,
        status: scalar,
        call_id: scalar,
        output: (value) => messageContent(value),
      });
    return content(value);
  };
  const chatCall = (value: unknown): unknown =>
    objectValue(value) && (value.type === undefined || value.type === 'function')
      ? visible(value, {
          id: scalar,
          type: scalar,
          function: (value) =>
            objectValue(value)
              ? visible(value, { name: scalar, arguments: argumentsValue })
              : privateReplay(),
        })
      : privateReplay();
  const chatMessage = (value: unknown): unknown =>
    objectValue(value)
      ? visible(value, {
          role: scalar,
          name: scalar,
          tool_call_id: scalar,
          content: (value) => messageContent(value, true),
          tool_calls: (value) => (Array.isArray(value) ? value.map(chatCall) : privateReplay()),
        })
      : privateReplay();
  let rootFields: Fields;
  switch (protocol) {
    case 'openai-responses':
    case 'openai-codex-backend':
      rootFields = {
        input: (value) => (Array.isArray(value) ? value.map(responsesItem) : privateReplay()),
        conversation: privateReplay,
        previous_response_id: privateReplay,
      };
      break;
    case 'openai-chat-completions':
      rootFields = {
        messages: (value) => (Array.isArray(value) ? value.map(chatMessage) : privateReplay()),
      };
      break;
    default:
      throw new Error('Unsupported diagnostic protocol.');
  }
  const body: unknown = JSON.parse(serialized);
  if (!objectValue(body)) throw new Error('Diagnostic request must be an object.');
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (Object.hasOwn(rootFields, key)) output[key] = rootFields[key]!(value);
    else Object.assign(output, ordinary({ [key]: value }));
  }
  return JSON.stringify(output);
}
