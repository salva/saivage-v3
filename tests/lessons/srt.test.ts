import { describe, expect, it } from '@jest/globals';
import { formatSrtTimestamp, parseSrtBlocks, scriptToSrt } from '../../src/lessons/srt.js';

const script = {
  lessonId: '001',
  title: 'Orientation',
  cues: [
    {
      id: 'intro',
      startSeconds: 0,
      endSeconds: 2.5,
      narration: 'Welcome to Diedrico.',
      visualAction: 'Show workspace.',
    },
    {
      id: 'planes',
      startSeconds: 2.5,
      endSeconds: 65.25,
      narration: 'The canvas links horizontal and vertical projections.',
      visualAction: 'Point at the projection planes.',
    },
  ],
};

describe('lesson SRT generation', () => {
  it('formats timestamps with millisecond precision', () => {
    expect(formatSrtTimestamp(65.25)).toBe('00:01:05,250');
  });

  it('renders parseable SRT blocks from a lesson script', () => {
    const srt = scriptToSrt(script);
    expect(srt).toContain('1\n00:00:00,000 --> 00:00:02,500');
    expect(parseSrtBlocks(srt)).toEqual([
      { index: 1, start: '00:00:00,000', end: '00:00:02,500', text: 'Welcome to Diedrico.' },
      {
        index: 2,
        start: '00:00:02,500',
        end: '00:01:05,250',
        text: 'The canvas links horizontal and vertical projections.',
      },
    ]);
  });
});
