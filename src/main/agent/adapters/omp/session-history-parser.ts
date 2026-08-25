import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Activity,
  EventType,
  type SessionCaptureEventName,
  type SessionCaptureContext,
  type SessionEvent,
  type SessionHistoryParseResult,
  type SessionUsage,
} from '../../../../shared/types';
import { sourceEvidence } from '../../../execution-history/native-slice-ownership';
import type { SourceEvidence } from '../../../db/repositories/execution-history-repository';

const OMP_SESSIONS_ROOT = path.join(os.homedir(), '.omp', 'agent', 'sessions');
const SESSION_FILE_RE = /\.jsonl$/i;
const MAX_DISCOVERY_DIRS = 512;
const MAX_DISCOVERY_FILES = 2048;
const HEADER_READ_BYTES = 128 * 1024;
const CLOCK_SKEW_MS = 30_000;

export interface OmpSessionHeader {
  type: 'session';
  version: 3;
  id: string;
  cwd: string;
  timestamp?: string;
  title?: string;
}
/** Native identity/fingerprint metadata consumed by durable slice ownership. */
export function getOmpSourceEvidence(filePath: string, nativeSessionId: string): SourceEvidence | null {
  return sourceEvidence(filePath, nativeSessionId);
}

export function ompSessionsRoot(): string {
  return OMP_SESSIONS_ROOT;
}

/** Canonicalize the path in the same spirit as OMP's resolveEquivalentPath. */
export function canonicalizeOmpCwd(cwd: string): string {
  const resolved = path.resolve(cwd);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function sameCwd(left: string, right: string): boolean {
  const a = canonicalizeOmpCwd(left).replace(/[\\/]+$/, '');
  const b = canonicalizeOmpCwd(right).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function encodeRelativeSessionDirName(prefix: string, relative: string): string {
  const encoded = relative.replace(/[\\/:]/g, '-');
  return encoded ? `${prefix}${prefix.endsWith('-') ? '' : '-'}${encoded}` : prefix;
}

/** OMP's canonical path-encoded bucket name (18.x). */
export function ompSessionDirectory(cwd: string, sessionsRoot = OMP_SESSIONS_ROOT): string {
  const canonicalCwd = canonicalizeOmpCwd(cwd);
  const home = canonicalizeOmpCwd(os.homedir());
  const temp = canonicalizeOmpCwd(os.tmpdir());
  const homeRelative = path.relative(home, canonicalCwd);
  const tempRelative = path.relative(temp, canonicalCwd);
  if (homeRelative === '' || (!homeRelative.startsWith('..') && !path.isAbsolute(homeRelative))) {
    return path.join(sessionsRoot, encodeRelativeSessionDirName('-', homeRelative));
  }
  if (tempRelative === '' || (!tempRelative.startsWith('..') && !path.isAbsolute(tempRelative))) {
    return path.join(sessionsRoot, encodeRelativeSessionDirName('-tmp-', tempRelative));
  }
  const rootStripped = canonicalCwd.replace(/^[/\\]/, '').replace(/[\\/:]/g, '-');
  return path.join(sessionsRoot, `--${rootStripped}--`);
}

function normalizePath(filePath: string): string {
  return path.normalize(path.resolve(filePath));
}

function readBounded(filePath: string, maxBytes = HEADER_READ_BYTES): string {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const stat = fs.fstatSync(fd);
      const length = Math.min(stat.size, maxBytes);
      if (length <= 0) return '';
      const buffer = Buffer.alloc(length);
      const bytesRead = fs.readSync(fd, buffer, 0, length, 0);
      return buffer.toString('utf8', 0, bytesRead);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function recordFromLine(line: string): Record<string, unknown> | null {
  const trimmed = line.replace(/\0/g, '').trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    // A partially written physical title slot can contain padding around the
    // JSON object. Recover only a complete object; never guess through JSON.
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      const parsed: unknown = JSON.parse(trimmed.slice(start, end + 1));
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

export function parseOmpHeader(content: string): OmpSessionHeader | null {
  for (const line of content.split(/\r?\n/)) {
    const record = recordFromLine(line);
    if (!record || record.type !== 'session' || record.version !== 3) continue;
    if (typeof record.id !== 'string' || record.id.length === 0 || typeof record.cwd !== 'string') continue;
    return {
      type: 'session',
      version: 3,
      id: record.id,
      cwd: record.cwd,
      timestamp: typeof record.timestamp === 'string' ? record.timestamp : undefined,
      title: typeof record.title === 'string' ? record.title : undefined,
    };
  }
  return null;
}

function listSessionFiles(directory: string): string[] {
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && SESSION_FILE_RE.test(entry.name))
      .map((entry) => path.join(directory, entry.name));
  } catch {
    return [];
  }
}

function snapshotFiles(directory: string): ReadonlySet<string> {
  return new Set(listSessionFiles(directory).map(normalizePath));
}

export function prepareOmpSessionCaptureContext(options: {
  cwd: string;
  launchStartedAt?: Date;
  processId?: number;
  timeoutMs?: number;
}): SessionCaptureContext {
  const rolloutRoot = OMP_SESSIONS_ROOT;
  return {
    processId: options.processId ?? 0,
    launchStartedAt: options.launchStartedAt ?? new Date(),
    cwd: canonicalizeOmpCwd(options.cwd),
    rolloutRoot,
    preLaunchRollouts: snapshotFiles(ompSessionDirectory(options.cwd, rolloutRoot)),
    timeoutMs: options.timeoutMs ?? 10_000,
  };
}

function timestampNearLaunch(header: OmpSessionHeader, launchMs: number): boolean {
  if (!header.timestamp) return true;
  const timestamp = Date.parse(header.timestamp);
  return !Number.isFinite(timestamp) || Math.abs(timestamp - launchMs) <= CLOCK_SKEW_MS;
}

function statMtime(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Capture the exact session created by a launch. Candidates are restricted to
 * the cwd bucket, must be new/changed since the pre-launch snapshot, and must
 * contain a v3 header matching both cwd and launch-time metadata. Ambiguity
 * fails closed instead of selecting the global newest file.
 */
export async function captureOmpSessionFromFilesystem(options: {
  spawnedAt: Date;
  cwd: string;
  processId?: number;
  launchStartedAt?: Date;
  rolloutRoot?: string;
  preLaunchRollouts?: ReadonlySet<string> | readonly string[];
  timeoutMs?: number;
  maxAttempts?: number;
  onEvent?: (name: SessionCaptureEventName, props: Record<string, string | number | boolean>) => void;
  shouldStop?: () => boolean;
}): Promise<string | null> {
  const launchStartedAt = options.launchStartedAt ?? options.spawnedAt;
  const launchMs = launchStartedAt.getTime();
  const root = options.rolloutRoot ?? OMP_SESSIONS_ROOT;
  const directory = ompSessionDirectory(options.cwd, root);
  const preLaunch = new Set(Array.from(options.preLaunchRollouts ?? [], normalizePath));
  const timeoutMs = options.timeoutMs ?? ((options.maxAttempts ?? 20) * 500);
  const maxAttempts = options.maxAttempts ?? Math.max(1, Math.ceil(timeoutMs / 500));

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (options.shouldStop?.()) return null;
    const matches: Array<{ id: string; filePath: string; mtime: number }> = [];
    for (const filePath of listSessionFiles(directory)) {
      const normalized = normalizePath(filePath);
      const mtime = statMtime(filePath);
      if (mtime === null || mtime < launchMs - CLOCK_SKEW_MS) continue;
      if (preLaunch.has(normalized) && mtime < launchMs) continue;
      const header = parseOmpHeader(readBounded(filePath));
      if (!header || !sameCwd(header.cwd, options.cwd) || !timestampNearLaunch(header, launchMs)) continue;
      matches.push({ id: header.id, filePath, mtime });
    }
    if (matches.length === 1) return matches[0].id;
    if (matches.length > 1) return null;
    if (attempt + 1 < maxAttempts) await sleep(Math.min(500, Math.max(0, timeoutMs / maxAttempts)));
  }
  return null;
}

function findSessionById(
  sessionId: string,
  sessionsRoot = OMP_SESSIONS_ROOT,
  preferredCwd?: string,
): { filePath: string; header: OmpSessionHeader } | null {
  const escaped = sessionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const namePattern = new RegExp(`(?:^|_)${escaped}\\.jsonl$`, 'i');
  const directories: string[] = [];
  const preferredDirectory = preferredCwd ? ompSessionDirectory(preferredCwd, sessionsRoot) : null;
  if (preferredDirectory) directories.push(preferredDirectory);
  // OMP accepts an explicit --session-dir and stores files directly in that
  // directory rather than creating the cwd-derived bucket beneath it.
  if (!preferredDirectory || normalizePath(preferredDirectory) !== normalizePath(sessionsRoot)) {
    directories.push(sessionsRoot);
  }
  try {
    for (const entry of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(sessionsRoot, entry.name);
      if (directories.some((candidate) => normalizePath(candidate) === normalizePath(directory))) continue;
      directories.push(directory);
      if (directories.length >= MAX_DISCOVERY_DIRS) break;
    }
  } catch {
    return null;
  }
  for (const directory of directories) {
    for (const filePath of listSessionFiles(directory).slice(0, MAX_DISCOVERY_FILES)) {
      if (!namePattern.test(path.basename(filePath))) continue;
      const header = parseOmpHeader(readBounded(filePath));
      if (header?.id === sessionId) return { filePath, header };
    }
  }
  return null;
}

/** Locate a known OMP session, refusing a header whose cwd has moved. */
export async function locateOmpSessionFile(
  agentSessionId: string,
  cwd: string,
  sessionsRoot = OMP_SESSIONS_ROOT,
): Promise<string | null> {
  const found = findSessionById(agentSessionId, sessionsRoot, cwd);
  if (!found || !sameCwd(found.header.cwd, cwd)) return null;
  return found.filePath;
}

/** Fail visibly before spawning rather than allowing OMP's relocation prompt. */
export function assertOmpResumeSession(
  agentSessionId: string,
  cwd: string,
  sessionsRoot = OMP_SESSIONS_ROOT,
): void {
  const found = findSessionById(agentSessionId, sessionsRoot, cwd);
  if (!found) throw new Error(`OMP session "${agentSessionId}" was not found; resume refused`);
  if (!sameCwd(found.header.cwd, cwd)) {
    throw new Error(`OMP session "${agentSessionId}" belongs to ${found.header.cwd}; resume refused for ${cwd}`);
  }
}


/** Parse bounded native JSONL telemetry; unknown or malformed records are ignored. */
export function parseOmpSessionHistory(content: string, _mode: 'full' | 'append'): SessionHistoryParseResult {
  let modelId: string | undefined;
  let contextWindowSize: number | undefined;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let cacheReadTokens: number | undefined;
  let cacheWriteTokens: number | undefined;
  const events: SessionEvent[] = [];
  let activity: 'thinking' | 'idle' | null = null;

  for (const line of content.split(/\r?\n/)) {
    const record = recordFromLine(line);
    if (!record || record.type !== 'message' || !isRecord(record.message)) continue;
    const message = record.message;
    const role = message.role;
    const timestamp = parseTimestamp(record.timestamp ?? message.timestamp);
    if (typeof message.model === 'string' && message.model) modelId = message.model;
    const usage = isRecord(message.usage) ? message.usage : isRecord(record.usage) ? record.usage : null;
    if (usage) {
      inputTokens = numberFrom(usage, 'inputTokens', 'input', 'promptTokens') ?? inputTokens;
      outputTokens = numberFrom(usage, 'outputTokens', 'output', 'completionTokens') ?? outputTokens;
      cacheReadTokens = numberFrom(usage, 'cacheReadTokens', 'cacheRead') ?? cacheReadTokens;
      cacheWriteTokens = numberFrom(usage, 'cacheWriteTokens', 'cacheWrite') ?? cacheWriteTokens;
      contextWindowSize = numberFrom(usage, 'contextWindowSize', 'contextWindow') ?? contextWindowSize;
    }
    if (role === 'assistant') {
      activity = 'idle';
      const contentBlocks = Array.isArray(message.content) ? message.content : [];
      for (const block of contentBlocks) {
        if (!isRecord(block)) continue;
        const tool = isRecord(block.toolCall) ? block.toolCall : isRecord(block.tool_call) ? block.tool_call : null;
        if (tool) {
          const name = typeof tool.name === 'string' ? tool.name : 'tool';
          const toolId = typeof tool.id === 'string' ? tool.id : undefined;
          events.push({ ts: timestamp, type: EventType.ToolStart, tool: name, toolId, detail: name });
        }
      }
    } else if (role === 'toolResult' || role === 'tool_result' || role === 'tool') {
      const toolId = typeof message.toolCallId === 'string' ? message.toolCallId : undefined;
      events.push({ ts: timestamp, type: EventType.ToolEnd, tool: 'tool', toolId });
      activity = 'idle';
    } else if (role === 'user') {
      activity = 'thinking';
    }
  }

  const hasUsage = modelId !== undefined || inputTokens !== undefined || outputTokens !== undefined;
  return {
    usage: hasUsage ? buildUsage({ modelId, contextWindowSize, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }) : null,
    events,
    activity: activity === 'thinking' ? Activity.Thinking : activity === 'idle' ? Activity.Idle : null,
  };
}

function buildUsage(values: {
  modelId?: string;
  contextWindowSize?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}): SessionUsage {
  const input = values.inputTokens ?? 0;
  const output = values.outputTokens ?? 0;
  const cacheRead = values.cacheReadTokens ?? 0;
  const cacheWrite = values.cacheWriteTokens ?? 0;
  const window = values.contextWindowSize ?? Math.max(input, 1);
  return {
    contextWindow: {
      usedPercentage: window > 0 ? Math.min(100, (input / window) * 100) : 0,
      usedTokens: input,
      cacheTokens: cacheRead + cacheWrite,
      totalInputTokens: input,
      totalOutputTokens: output,
      contextWindowSize: window,
    },
    cost: { totalCostUsd: 0, totalDurationMs: 0 },
    model: { id: values.modelId ?? 'unknown', displayName: values.modelId ?? 'Unknown' },
  };
}

function numberFrom(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function parseTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
