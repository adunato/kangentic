import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  CapturedSession,
  RolloutCandidate,
  SessionCaptureContext,
  SessionCaptureErrorCode,
  SessionCaptureEventName,
} from '../../../../shared/types';

const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_RE = new RegExp(`^${UUID_PATTERN}$`, 'i');
const ROLLOUT_RE = new RegExp(`^rollout-.*-(${UUID_PATTERN})\\.jsonl$`, 'i');
const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;
const MAX_FIRST_RECORD_BYTES = 64 * 1024;
const LAUNCH_CLOCK_SKEW_MS = 1_000;

export class CodexRolloutCaptureError extends Error {
  constructor(
    readonly code: SessionCaptureErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CodexRolloutCaptureError';
  }
}

export interface PrepareCodexCaptureOptions {
  cwd: string;
  launchStartedAt: Date;
  processId?: number;
  timeoutMs?: number;
}

export function resolveCodexHome(): string {
  return process.env.CODEX_HOME && process.env.CODEX_HOME.trim().length > 0
    ? process.env.CODEX_HOME
    : path.join(os.homedir(), '.codex');
}

export function resolveCodexRolloutRoot(codexHome = resolveCodexHome()): string {
  return path.join(codexHome, 'sessions');
}

export function prepareCodexSessionCaptureContext(options: PrepareCodexCaptureOptions): SessionCaptureContext {
  const rolloutRoot = resolveCodexRolloutRoot();
  return {
    processId: options.processId ?? 0,
    launchStartedAt: options.launchStartedAt,
    cwd: canonicalizeCwd(options.cwd),
    rolloutRoot,
    preLaunchRollouts: snapshotRolloutPaths(rolloutRoot),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

export async function captureCodexSessionFromRollout(
  context: SessionCaptureContext & {
    maxAttempts?: number;
    onEvent?: (name: SessionCaptureEventName, props: Record<string, string | number | boolean>) => void;
    shouldStop?: () => boolean;
  },
): Promise<CapturedSession | null> {
  const timeoutMs = context.maxAttempts !== undefined
    ? Math.max(1, context.maxAttempts) * 500
    : context.timeoutMs;
  const startedAtMs = Date.now();
  const deadline = startedAtMs + timeoutMs;
  const preLaunch = normalizePathSet(context.preLaunchRollouts);
  const seenPaths = new Set<string>();
  let rootWasReadable = false;
  let watcher: fs.FSWatcher | null = null;

  context.onEvent?.('codex_session_capture_started', eventProps(context, {
    source: 'rollout',
    candidateCount: 0,
    durationMs: 0,
  }));

  try {
    watcher = tryWatchRolloutRoot(context.rolloutRoot, () => {
      context.onEvent?.('codex_session_capture_pending', eventProps(context, {
        source: 'rollout',
        candidateCount: seenPaths.size,
        durationMs: Date.now() - startedAtMs,
      }));
    });

    while (Date.now() <= deadline) {
      if (context.shouldStop?.()) return null;
      let files: string[] = [];
      try {
        files = listRolloutFiles(context.rolloutRoot);
        rootWasReadable = true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code && code !== 'ENOENT') {
          throw new CodexRolloutCaptureError('ROLLOUT_READ_FAILED', `Failed reading Codex rollout root: ${code}`);
        }
      }

      const valid: RolloutCandidate[] = [];
      for (const filePath of files) {
        const normalizedPath = normalizeFilePath(filePath);
        if (preLaunch.has(normalizedPath)) continue;
        const filenameSessionId = extractSessionIdFromFilename(path.basename(filePath));
        if (!filenameSessionId) continue;

        if (!seenPaths.has(normalizedPath)) {
          seenPaths.add(normalizedPath);
          context.onEvent?.('codex_rollout_candidate_seen', eventProps(context, {
            source: 'rollout',
            candidateCount: seenPaths.size,
            rolloutPath: sanitizeRolloutPath(filePath, context.rolloutRoot),
            durationMs: Date.now() - startedAtMs,
          }));
        }

        if (rolloutMtimeMs(filePath) < context.launchStartedAt.getTime() - 30_000) continue;
        const parsed = readRolloutCandidate(filePath, filenameSessionId);
        if (parsed.kind === 'pending') continue;
        if (parsed.kind === 'invalid') continue;
        if (parsed.candidate.filenameSessionId !== parsed.candidate.metadataSessionId) continue;
        if (!isPostLaunchCompatible(parsed.candidate.createdAt, context.launchStartedAt, timeoutMs)) continue;
        if (parsed.candidate.cwd && !sameCwd(parsed.candidate.cwd, context.cwd)) continue;
        valid.push(parsed.candidate);
      }

      if (valid.length > 1) {
        context.onEvent?.('codex_session_capture_ambiguous', eventProps(context, {
          source: 'rollout',
          candidateCount: valid.length,
          durationMs: Date.now() - startedAtMs,
        }));
        throw new CodexRolloutCaptureError('ROLLOUT_AMBIGUOUS', 'Multiple equally valid Codex rollout candidates matched this launch');
      }
      if (valid.length === 1) {
        const captured: CapturedSession = {
          id: valid[0].filenameSessionId,
          source: 'rollout',
          rolloutPath: valid[0].path,
        };
        context.onEvent?.('codex_session_id_captured', eventProps(context, {
          source: 'rollout',
          candidateCount: seenPaths.size,
          rolloutPath: sanitizeRolloutPath(valid[0].path, context.rolloutRoot),
          durationMs: Date.now() - startedAtMs,
        }));
        context.onEvent?.('codex_session_capture_completed', eventProps(context, {
          source: 'rollout',
          candidateCount: seenPaths.size,
          rolloutPath: sanitizeRolloutPath(valid[0].path, context.rolloutRoot),
          durationMs: Date.now() - startedAtMs,
        }));
        return captured;
      }

      await sleep(POLL_INTERVAL_MS);
    }

    const code: SessionCaptureErrorCode = rootWasReadable ? 'CAPTURE_TIMEOUT' : 'ROLLOUT_ROOT_UNAVAILABLE';
    context.onEvent?.('codex_session_capture_timeout', eventProps(context, {
      source: 'rollout',
      candidateCount: seenPaths.size,
      durationMs: Date.now() - startedAtMs,
      errorCode: code,
    }));
    throw new CodexRolloutCaptureError(code, `Codex rollout capture timed out after ${timeoutMs}ms`);
  } finally {
    watcher?.close();
  }
}

export function extractSessionIdFromFilename(filename: string): string | null {
  const match = filename.match(ROLLOUT_RE);
  const id = match?.[1];
  return id && UUID_RE.test(id) ? id.toLowerCase() : null;
}

export function readRolloutCandidate(filePath: string, filenameSessionId: string):
  | { kind: 'candidate'; candidate: RolloutCandidate }
  | { kind: 'pending' }
  | { kind: 'invalid'; code: SessionCaptureErrorCode } {
  let content: string;
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(MAX_FIRST_RECORD_BYTES);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      content = buffer.subarray(0, bytesRead).toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { kind: 'invalid', code: 'ROLLOUT_READ_FAILED' };
  }

  const newlineIndex = content.search(/\r?\n/);
  if (newlineIndex < 0) return { kind: 'pending' };
  const firstLine = content.slice(0, newlineIndex).trim();
  if (!firstLine) return { kind: 'pending' };

  let entry: unknown;
  try {
    entry = JSON.parse(firstLine);
  } catch {
    return { kind: 'pending' };
  }
  if (!isRecord(entry) || entry.type !== 'session_meta' || !isRecord(entry.payload)) {
    return { kind: 'invalid', code: 'ROLLOUT_INVALID' };
  }

  const metadataId = entry.payload.id ?? entry.payload.session_id;
  if (typeof metadataId !== 'string' || !UUID_RE.test(metadataId)) {
    return { kind: 'invalid', code: 'ROLLOUT_INVALID' };
  }
  const normalizedMetadataId = metadataId.toLowerCase();
  if (normalizedMetadataId !== filenameSessionId.toLowerCase()) {
    return { kind: 'invalid', code: 'ROLLOUT_MISMATCH' };
  }

  const cwd = typeof entry.payload.cwd === 'string' ? entry.payload.cwd : undefined;
  const createdAtRaw = typeof entry.payload.timestamp === 'string'
    ? entry.payload.timestamp
    : typeof entry.timestamp === 'string'
      ? entry.timestamp
      : null;
  const createdAt = createdAtRaw ? new Date(createdAtRaw) : readCreatedAtFromStat(filePath);
  if (!createdAt) return { kind: 'pending' };
  if (Number.isNaN(createdAt.getTime())) {
    return { kind: 'invalid', code: 'ROLLOUT_INVALID' };
  }

  return {
    kind: 'candidate',
    candidate: {
      path: filePath,
      filenameSessionId: filenameSessionId.toLowerCase(),
      metadataSessionId: normalizedMetadataId,
      cwd,
      createdAt,
    },
  };
}

export function snapshotRolloutPaths(rolloutRoot: string): ReadonlySet<string> {
  try {
    return new Set(listRolloutFiles(rolloutRoot).map(normalizeFilePath));
  } catch {
    return new Set();
  }
}

export function sanitizeRolloutPath(filePath: string, rolloutRoot: string): string {
  const relative = path.relative(rolloutRoot, filePath);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return `<codex_sessions>/${relative.split(path.sep).join('/')}`;
  }
  return `<codex_sessions>/${path.basename(filePath)}`;
}

export function codexWorktreeKey(cwd: string): string {
  return crypto.createHash('sha256').update(canonicalizeCwd(cwd)).digest('hex').slice(0, 12);
}

function eventProps(
  context: SessionCaptureContext,
  extra: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  return {
    agent: 'codex',
    processId: context.processId,
    worktreeKey: codexWorktreeKey(context.cwd),
    ...extra,
  };
}

function listRolloutFiles(rolloutRoot: string): string[] {
  const result: string[] = [];
  const years = safeReaddir(rolloutRoot);
  for (const year of years) {
    if (!/^\d{4}$/.test(year.name) || !year.isDirectory()) continue;
    for (const month of safeReaddir(path.join(rolloutRoot, year.name))) {
      if (!/^\d{2}$/.test(month.name) || !month.isDirectory()) continue;
      for (const day of safeReaddir(path.join(rolloutRoot, year.name, month.name))) {
        if (!/^\d{2}$/.test(day.name) || !day.isDirectory()) continue;
        const dayDir = path.join(rolloutRoot, year.name, month.name, day.name);
        for (const file of safeReaddir(dayDir)) {
          if (file.isFile() && extractSessionIdFromFilename(file.name)) {
            result.push(path.join(dayDir, file.name));
          }
        }
      }
    }
  }
  return result;
}

function safeReaddir(directory: string): fs.Dirent[] {
  return fs.readdirSync(directory, { withFileTypes: true });
}

function tryWatchRolloutRoot(rolloutRoot: string, onChange: () => void): fs.FSWatcher | null {
  try {
    if (!fs.existsSync(rolloutRoot)) return null;
    return fs.watch(rolloutRoot, { recursive: true }, onChange);
  } catch {
    return null;
  }
}

function rolloutMtimeMs(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function readCreatedAtFromStat(filePath: string): Date | null {
  try {
    return new Date(fs.statSync(filePath).mtimeMs);
  } catch {
    return null;
  }
}

function normalizePathSet(paths: ReadonlySet<string> | readonly string[]): Set<string> {
  const values = paths instanceof Set ? Array.from(paths) : Array.from(paths);
  return new Set(values.map(normalizeFilePath));
}

function normalizeFilePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function canonicalizeCwd(cwd: string): string {
  const resolved = path.resolve(cwd);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function sameCwd(a: string, b: string): boolean {
  return canonicalizeCwd(a) === canonicalizeCwd(b);
}

function isPostLaunchCompatible(createdAt: Date, launchStartedAt: Date, timeoutMs: number): boolean {
  const createdAtMs = createdAt.getTime();
  const launchStartedAtMs = launchStartedAt.getTime();
  return createdAtMs >= launchStartedAtMs - LAUNCH_CLOCK_SKEW_MS
    && createdAtMs <= launchStartedAtMs + timeoutMs + LAUNCH_CLOCK_SKEW_MS;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
