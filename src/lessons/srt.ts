import type { LessonScript, LessonScriptCue } from './types.js';

function assertFiniteSeconds(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number`);
  }
}

export function formatSrtTimestamp(seconds: number): string {
  assertFiniteSeconds(seconds, 'seconds');
  const millisecondsTotal = Math.round(seconds * 1000);
  const hours = Math.floor(millisecondsTotal / 3_600_000);
  const minutes = Math.floor((millisecondsTotal % 3_600_000) / 60_000);
  const wholeSeconds = Math.floor((millisecondsTotal % 60_000) / 1000);
  const milliseconds = millisecondsTotal % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')},${String(milliseconds).padStart(3, '0')}`;
}

function normalizeCueText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

export function cueToSrtBlock(cue: LessonScriptCue, index: number): string {
  assertFiniteSeconds(cue.startSeconds, `cue ${cue.id} startSeconds`);
  assertFiniteSeconds(cue.endSeconds, `cue ${cue.id} endSeconds`);
  if (cue.endSeconds <= cue.startSeconds) {
    throw new Error(`cue ${cue.id} endSeconds must be greater than startSeconds`);
  }
  const text = normalizeCueText(cue.narration);
  if (text.length === 0) {
    throw new Error(`cue ${cue.id} narration must not be empty`);
  }
  return `${index}\n${formatSrtTimestamp(cue.startSeconds)} --> ${formatSrtTimestamp(cue.endSeconds)}\n${text}`;
}

export function scriptToSrt(script: LessonScript): string {
  if (script.cues.length === 0) {
    throw new Error('script must contain at least one cue');
  }
  return `${script.cues.map((cue, index) => cueToSrtBlock(cue, index + 1)).join('\n\n')}\n`;
}

export function parseSrtBlocks(srt: string): Array<{ index: number; start: string; end: string; text: string }> {
  return srt
    .trim()
    .split(/\n\s*\n/)
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n');
      const index = Number(lines[0]);
      const timing = lines[1]?.match(/^(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})$/);
      if (!Number.isInteger(index) || !timing || lines.slice(2).join('\n').trim().length === 0) {
        throw new Error(`invalid SRT block: ${block}`);
      }
      return { index, start: timing[1], end: timing[2], text: lines.slice(2).join('\n') };
    });
}
