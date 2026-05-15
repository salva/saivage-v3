import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  PlannerDispatchCompletion,
  PlannerDispatchRecord,
  PlannerDispatchStatus,
  PlannerFrameRecord,
  PlannerFrameStatus,
  PlannerResumeReason,
} from '../schemas/types.js';
import {
  plannerDispatchRecordSchema,
  plannerFrameRecordSchema,
} from '../schemas/validators.js';
import { writeFileAtomic } from './file-tree.js';

function now(): string {
  return new Date().toISOString();
}

function runtimeDir(projectRoot: string): string {
  return join(projectRoot, '.saivage', 'runtime');
}

function framesDir(projectRoot: string): string {
  return join(runtimeDir(projectRoot), 'planner-frames');
}

function dispatchesDir(projectRoot: string): string {
  return join(runtimeDir(projectRoot), 'planner-dispatches');
}

function framePath(projectRoot: string, frameId: string): string {
  return join(framesDir(projectRoot), `${frameId}.json`);
}

function dispatchPath(projectRoot: string, dispatchId: string): string {
  return join(dispatchesDir(projectRoot), `${dispatchId}.json`);
}

function parseJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

function validateFrame(frame: PlannerFrameRecord): PlannerFrameRecord {
  return plannerFrameRecordSchema.parse(frame);
}

function validateDispatch(dispatch: PlannerDispatchRecord): PlannerDispatchRecord {
  return plannerDispatchRecordSchema.parse(dispatch);
}

export class PlannerControlService {
  constructor(private readonly projectRoot: string) {
    mkdirSync(framesDir(projectRoot), { recursive: true });
    mkdirSync(dispatchesDir(projectRoot), { recursive: true });
  }

  listFrames(): PlannerFrameRecord[] {
    if (!existsSync(framesDir(this.projectRoot))) return [];
    return readdirSync(framesDir(this.projectRoot))
      .filter((name) => name.endsWith('.json'))
      .map((name) => this.readFrame(name.replace(/\.json$/, '')))
      .filter((frame): frame is PlannerFrameRecord => frame !== null)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  readFrame(frameId: string): PlannerFrameRecord | null {
    const path = framePath(this.projectRoot, frameId);
    if (!existsSync(path)) return null;
    return validateFrame(parseJsonFile<PlannerFrameRecord>(path));
  }

  upsertFrame(frame: PlannerFrameRecord): PlannerFrameRecord {
    const validated = validateFrame(frame);
    writeFileAtomic(framePath(this.projectRoot, validated.frame_id), JSON.stringify(validated, null, 2) + '\n');
    return validated;
  }

  ensureFrame(plannerCardId: string, plannerScope: 'project' | 'goal'): PlannerFrameRecord {
    const existing = this.listFrames().find(
      (frame) => frame.planner_card_id === plannerCardId && frame.status !== 'completed' && frame.status !== 'failed',
    );
    if (existing) {
      return existing;
    }
    const timestamp = Date.now();
    return this.upsertFrame({
      frame_id: `frm-${plannerCardId}-${timestamp}`,
      planner_card_id: plannerCardId,
      planner_role: 'planner',
      planner_scope: plannerScope,
      status: 'running',
      resume_reason: 'none',
      waiting_on_dispatch_ids: [],
      last_resume_cursor: null,
      last_dispatch_id: null,
      created_at: now(),
      updated_at: now(),
    });
  }

  updateFrame(frameId: string, changes: Partial<PlannerFrameRecord>): PlannerFrameRecord {
    const current = this.readFrame(frameId);
    if (!current) {
      throw new Error(`Planner frame '${frameId}' not found.`);
    }
    return this.upsertFrame({
      ...current,
      ...changes,
      frame_id: current.frame_id,
      planner_card_id: current.planner_card_id,
      planner_role: current.planner_role,
      planner_scope: current.planner_scope,
      created_at: current.created_at,
      updated_at: now(),
    });
  }

  listDispatches(filters?: {
    parent_frame_id?: string;
    parent_card_id?: string;
    target_card_id?: string;
    status?: PlannerDispatchStatus;
  }): PlannerDispatchRecord[] {
    if (!existsSync(dispatchesDir(this.projectRoot))) return [];
    return readdirSync(dispatchesDir(this.projectRoot))
      .filter((name) => name.endsWith('.json'))
      .map((name) => this.readDispatch(name.replace(/\.json$/, '')))
      .filter((dispatch): dispatch is PlannerDispatchRecord => dispatch !== null)
      .filter((dispatch) => {
        if (filters?.parent_frame_id && dispatch.parent_frame_id !== filters.parent_frame_id) return false;
        if (filters?.parent_card_id && dispatch.parent_card_id !== filters.parent_card_id) return false;
        if (filters?.target_card_id && dispatch.target_card_id !== filters.target_card_id) return false;
        if (filters?.status && dispatch.status !== filters.status) return false;
        return true;
      })
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  readDispatch(dispatchId: string): PlannerDispatchRecord | null {
    const path = dispatchPath(this.projectRoot, dispatchId);
    if (!existsSync(path)) return null;
    return validateDispatch(parseJsonFile<PlannerDispatchRecord>(path));
  }

  createDispatch(params: {
    parentFrameId: string;
    parentCardId: string;
    targetCardId: string;
    targetKind: 'goal' | 'terminal_card';
    requestedByScope: 'project' | 'goal';
    idempotencyKey: string;
  }): PlannerDispatchRecord {
    const existing = this.listDispatches({ parent_frame_id: params.parentFrameId }).find(
      (dispatch) =>
        dispatch.target_card_id === params.targetCardId &&
        dispatch.idempotency_key === params.idempotencyKey,
    );
    if (existing) return existing;

    const dispatch: PlannerDispatchRecord = {
      dispatch_id: `dsp-${params.targetCardId}-${Date.now()}`,
      parent_frame_id: params.parentFrameId,
      parent_card_id: params.parentCardId,
      target_card_id: params.targetCardId,
      target_kind: params.targetKind,
      requested_by_role: 'planner',
      requested_by_scope: params.requestedByScope,
      status: 'queued',
      completion: null,
      idempotency_key: params.idempotencyKey,
      created_at: now(),
      started_at: null,
      completed_at: null,
    };

    const saved = this.upsertDispatch(dispatch);
    const frame = this.readFrame(params.parentFrameId);
    if (frame) {
      const waiting = Array.from(new Set([...frame.waiting_on_dispatch_ids, saved.dispatch_id]));
      this.updateFrame(frame.frame_id, {
        status: 'suspended',
        resume_reason: 'none',
        waiting_on_dispatch_ids: waiting,
        last_dispatch_id: saved.dispatch_id,
      });
    }
    return saved;
  }

  upsertDispatch(dispatch: PlannerDispatchRecord): PlannerDispatchRecord {
    const validated = validateDispatch(dispatch);
    writeFileAtomic(dispatchPath(this.projectRoot, validated.dispatch_id), JSON.stringify(validated, null, 2) + '\n');
    return validated;
  }

  markDispatchRunning(dispatchId: string): PlannerDispatchRecord {
    const current = this.readDispatch(dispatchId);
    if (!current) throw new Error(`Planner dispatch '${dispatchId}' not found.`);
    return this.upsertDispatch({
      ...current,
      status: 'running',
      started_at: current.started_at ?? now(),
    });
  }

  markDispatchCompleted(
    dispatchId: string,
    status: Extract<PlannerDispatchStatus, 'completed' | 'failed' | 'blocked' | 'cancelled' | 'timed_out'>,
    completion: PlannerDispatchCompletion,
    resumeReason: PlannerResumeReason = 'dispatch_completed',
  ): PlannerDispatchRecord {
    const current = this.readDispatch(dispatchId);
    if (!current) throw new Error(`Planner dispatch '${dispatchId}' not found.`);
    const updated = this.upsertDispatch({
      ...current,
      status,
      completion,
      completed_at: now(),
      started_at: current.started_at ?? now(),
    });

    const frame = this.readFrame(updated.parent_frame_id);
    if (frame) {
      this.updateFrame(frame.frame_id, {
        status: 'resumable',
        resume_reason: resumeReason,
        waiting_on_dispatch_ids: frame.waiting_on_dispatch_ids.filter((id) => id !== dispatchId),
        last_dispatch_id: dispatchId,
        last_resume_cursor: updated.completed_at,
      });
    }

    return updated;
  }
}
