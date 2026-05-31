import { describe, expect, it } from '@jest/globals';
import { canMuxRecording, chooseTtsStrategy } from '../../src/lessons/tts.js';

describe('lesson TTS strategy', () => {
  it('prefers piper when it is available', () => {
    expect(chooseTtsStrategy({ ffmpeg: '/usr/bin/ffmpeg', piper: '/usr/bin/piper', espeakNg: '/usr/bin/espeak-ng' }).engine).toBe('piper');
  });

  it('falls back to espeak-ng when piper is missing', () => {
    expect(chooseTtsStrategy({ espeakNg: '/usr/bin/espeak-ng' }).engine).toBe('espeak-ng');
  });

  it('reports a blocked strategy when no supported TTS binary exists', () => {
    expect(chooseTtsStrategy({}).engine).toBe('blocked');
    expect(canMuxRecording({})).toBe(false);
  });
});
