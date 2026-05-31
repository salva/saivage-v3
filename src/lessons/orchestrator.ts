import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scriptToSrt } from './srt.js';
import { canMuxRecording, chooseTtsStrategy, type ToolAvailability } from './tts.js';
import type {
  LessonArtifact,
  LessonPlan,
  LessonProductionBlocker,
  LessonProductionPaths,
  LessonProductionResult,
  LessonScript,
} from './types.js';

export interface BootstrapLessonOptions {
  paths: LessonProductionPaths;
  plan: LessonPlan;
  script: LessonScript;
  tools: ToolAvailability;
  diedricoReachable: boolean;
  probeEvidence: string;
}

function artifact(path: string, kind: LessonArtifact['kind'], required = true): LessonArtifact {
  return { kind, path, required };
}

export function bootstrapLessonProduction(options: BootstrapLessonOptions): LessonProductionResult {
  mkdirSync(options.paths.lessonDir, { recursive: true });
  mkdirSync(options.paths.validationDir, { recursive: true });

  const planPath = join(options.paths.lessonDir, 'plan.md');
  const scriptPath = join(options.paths.lessonDir, 'script.md');
  const subtitlesPath = join(options.paths.lessonDir, 'subtitles.srt');
  const transcriptPath = join(options.paths.lessonDir, 'transcript.json');
  const metadataPath = join(options.paths.lessonDir, 'metadata.json');
  const recordingPath = join(options.paths.lessonDir, 'recording.mp4');
  const narrationPath = join(options.paths.lessonDir, 'narration.wav');

  writeFileSync(planPath, renderPlan(options.plan), 'utf-8');
  writeFileSync(scriptPath, renderScript(options.script), 'utf-8');
  writeFileSync(subtitlesPath, scriptToSrt(options.script), 'utf-8');
  writeFileSync(transcriptPath, `${JSON.stringify(options.script, null, 2)}\n`, 'utf-8');
  writeFileSync(
    metadataPath,
    `${JSON.stringify(
      {
        id: options.plan.id,
        slug: options.plan.slug,
        title: options.plan.title,
        status: options.diedricoReachable && chooseTtsStrategy(options.tools).engine !== 'blocked' && canMuxRecording(options.tools) ? 'ready' : 'blocked',
        ttsStrategy: chooseTtsStrategy(options.tools),
        diedricoReachable: options.diedricoReachable,
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );

  const blockers: LessonProductionBlocker[] = [];
  if (!options.diedricoReachable) {
    blockers.push({
      stage: 'probe',
      message: 'Diedrico Vite server was unreachable, so live Playwright walkthrough recording was skipped.',
      evidence: options.probeEvidence,
      nextStep: 'Retry recording after the operator-managed Diedrico service is reachable at http://127.0.0.1:5173/.',
    });
  }
  if (chooseTtsStrategy(options.tools).engine === 'blocked') {
    blockers.push({
      stage: 'tts',
      message: 'No supported TTS binary is available for narration.wav generation.',
      evidence: 'which ffmpeg piper espeak-ng returned no binary paths in this container.',
      nextStep: 'Provide piper on PATH as the single chosen TTS engine for the next cycle.',
    });
  }
  if (!canMuxRecording(options.tools)) {
    blockers.push({
      stage: 'mux',
      message: 'ffmpeg is unavailable, so raw recording/audio cannot be muxed to recording.mp4.',
      evidence: 'which ffmpeg piper espeak-ng returned no ffmpeg path in this container.',
      nextStep: 'Provide ffmpeg on PATH before the next mux/validation attempt.',
    });
  }

  return {
    plan: options.plan,
    script: options.script,
    blockers,
    artifacts: [
      artifact(planPath, 'plan'),
      artifact(scriptPath, 'script'),
      artifact(subtitlesPath, 'subtitles'),
      artifact(transcriptPath, 'transcript'),
      artifact(metadataPath, 'metadata'),
      artifact(recordingPath, 'recording'),
      artifact(narrationPath, 'narration'),
    ],
  };
}

function renderPlan(plan: LessonPlan): string {
  return `# ${plan.title}\n\n- Lesson ID: ${plan.id}\n- Audience: ${plan.audience}\n- Learning goal: ${plan.learningGoal}\n- Prerequisite UI state: ${plan.prerequisiteUiState}\n\n## Prerequisites\n${plan.prerequisites.map((item) => `- ${item}`).join('\n')}\n\n## Narration outline\n${plan.narrationOutline.map((item) => `- ${item}`).join('\n')}\n\n## Source citations\n${plan.sourceCitations.map((item) => `- ${item}`).join('\n')}\n`;
}

function renderScript(script: LessonScript): string {
  return `# ${script.title}\n\n${script.cues
    .map(
      (cue) =>
        `## ${cue.id}\n\n- Time: ${cue.startSeconds.toFixed(1)}s–${cue.endSeconds.toFixed(1)}s\n- Visual action: ${cue.visualAction}\n- Narration: ${cue.narration}\n`,
    )
    .join('\n')}`;
}
