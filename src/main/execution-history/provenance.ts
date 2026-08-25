import crypto from 'node:crypto';
import type { ExecutionProvenance } from '../../shared/types';

export interface ProvenanceInput {
  boardProfileId?: string | null;
  stage: { id?: string | null; name?: string | null; role?: string | null };
  effective: {
    agentId?: string | null;
    sessionType: string;
    model?: string | null;
    effort?: string | null;
    permissionMode?: string | null;
    autoSpawn?: boolean | null;
    sessionTarget?: string | null;
    spawnStrategy?: string | null;
  };
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
}

export function buildExecutionProvenance(input: ProvenanceInput, stageAttempt: number): ExecutionProvenance {
  const effective = input.effective;
  const canonical = stable({
    version: 1,
    boardProfileId: input.boardProfileId ?? null,
    stage: { id: input.stage.id ?? null, name: input.stage.name ?? null, role: input.stage.role ?? null },
    effective: {
      agentId: effective.agentId ?? null,
      sessionType: effective.sessionType,
      model: effective.model ?? null,
      effort: effective.effort ?? null,
      permissionMode: effective.permissionMode ?? null,
      autoSpawn: effective.autoSpawn ?? null,
      sessionTarget: effective.sessionTarget ?? null,
      spawnStrategy: effective.spawnStrategy ?? null,
    },
  });
  const configHash = crypto.createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
  return {
    stageId: input.stage.id ?? null,
    stageName: input.stage.name ?? null,
    stageRole: input.stage.role ?? null,
    stageAttempt,
    boardProfileId: input.boardProfileId ?? null,
    agentId: effective.agentId ?? null,
    sessionType: effective.sessionType,
    model: effective.model ?? null,
    effort: effective.effort ?? null,
    permissionMode: effective.permissionMode ?? null,
    configHash,
  };
}

export function canonicalizeProvenance(input: ProvenanceInput): string {
  return JSON.stringify(stable({
    version: 1,
    boardProfileId: input.boardProfileId ?? null,
    stage: { id: input.stage.id ?? null, name: input.stage.name ?? null, role: input.stage.role ?? null },
    effective: {
      agentId: input.effective.agentId ?? null,
      sessionType: input.effective.sessionType,
      model: input.effective.model ?? null,
      effort: input.effective.effort ?? null,
      permissionMode: input.effective.permissionMode ?? null,
      autoSpawn: input.effective.autoSpawn ?? null,
      sessionTarget: input.effective.sessionTarget ?? null,
      spawnStrategy: input.effective.spawnStrategy ?? null,
    },
  }));
}
