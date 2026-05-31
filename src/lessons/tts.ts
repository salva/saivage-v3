export interface ToolAvailability {
  ffmpeg?: string;
  piper?: string;
  espeakNg?: string;
}

export type TtsStrategy =
  | { engine: 'piper'; command: string; reason: string }
  | { engine: 'espeak-ng'; command: string; reason: string }
  | { engine: 'blocked'; command: null; reason: string };

export function chooseTtsStrategy(tools: ToolAvailability): TtsStrategy {
  if (tools.piper) {
    return {
      engine: 'piper',
      command: tools.piper,
      reason: 'piper is preferred when present because it produces WAV narration suitable for muxing.',
    };
  }
  if (tools.espeakNg) {
    return {
      engine: 'espeak-ng',
      command: tools.espeakNg,
      reason: 'espeak-ng is available as a deterministic local fallback for WAV narration.',
    };
  }
  return {
    engine: 'blocked',
    command: null,
    reason: 'No local TTS binary was found by `which ffmpeg piper espeak-ng`; install/provide piper for lesson narration.',
  };
}

export function canMuxRecording(tools: ToolAvailability): boolean {
  return Boolean(tools.ffmpeg);
}
