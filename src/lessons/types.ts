export type LessonArtifactKind =
  | 'plan'
  | 'script'
  | 'recording'
  | 'subtitles'
  | 'narration'
  | 'transcript'
  | 'metadata'
  | 'implementation-log';

export interface LessonArtifact {
  kind: LessonArtifactKind;
  path: string;
  required: boolean;
  mimeType?: string;
}

export interface LessonPlan {
  id: string;
  slug: string;
  title: string;
  audience: string;
  learningGoal: string;
  prerequisites: string[];
  prerequisiteUiState: string;
  narrationOutline: string[];
  sourceCitations: string[];
}

export interface LessonScriptCue {
  id: string;
  startSeconds: number;
  endSeconds: number;
  narration: string;
  visualAction: string;
}

export interface LessonScript {
  lessonId: string;
  title: string;
  cues: LessonScriptCue[];
}

export interface LessonProductionPaths {
  lessonsRoot: string;
  lessonDir: string;
  validationDir: string;
}

export interface LessonProductionBlocker {
  stage: 'probe' | 'record' | 'tts' | 'subtitles' | 'mux' | 'archive';
  message: string;
  evidence?: string;
  nextStep: string;
}

export interface LessonProductionResult {
  plan: LessonPlan;
  script: LessonScript;
  artifacts: LessonArtifact[];
  blockers: LessonProductionBlocker[];
}
