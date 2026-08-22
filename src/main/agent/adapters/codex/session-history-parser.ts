import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Activity,
  EventType,
  AgentTool,
  type CapturedSession,
  type SessionCaptureEventName,
  type SessionHistoryParseResult,
  type SessionUsage,
  type SessionEvent,
} from '../../../../shared/types';
import { captureCodexSessionFromRollout, prepareCodexSessionCaptureContext } from './rollout-capture';

/**
 * Parser for Codex CLI's native session history files (rollout JSONL).
 *
 * Path: `~/.codex/sessions/<UTC-YYYY>/<MM>/<DD>/rollout-<ts>-<sessionId>.jsonl`
 *
 * File format: append-only JSONL, one JSON object per line. Each entry
 * has `timestamp`, `type`, and `payload` fields. Recognized types we care
 * about for telemetry:
 *
 * - `session_meta`     → session UUID + cli_version + cwd (line 1)
 * - `task_started`     → `model_context_window` (context window size)
 *                        + triggers Activity.Thinking
 * - `turn_context`     → `model` field, follows mid-session `/model` changes
 * - `token_count`      → `info.total_token_usage` (input/output/cached totals)
 * - `task_complete`    → triggers Activity.Idle
 * - `response_item`    → `type: "function_call"` → SessionEvent ToolStart/ToolEnd
 *
 * All other entries are ignored. Defensive parsing throughout: any
 * malformed line is skipped without throwing.
 *
 * Cross-platform: uses os.homedir() + path.join for all filesystem
 * operations. No shell-outs. CRLF-tolerant line splitting.
 */
export class CodexSessionHistoryParser {
  /**
   * Scan `~/.codex/sessions/<today>/` for a rollout file whose
   * `session_meta` says it was created by our spawn, and return its
   * embedded session UUID. The only capture path that works on
   * Codex 0.118 (no PTY output, no hook support).
   *
   * Two-stage filter:
   *   1. mtime >= spawnedAt - 30s    (cheap pre-filter; avoids
   *      reading every historical rollout file, wide enough to not
   *      miss fresh writes on slow disks)
   *   2. session_meta.payload.timestamp is within ±1s of spawnedAt
   *      AND session_meta.payload.cwd matches our cwd
   *
   * The `payload.timestamp` is set ONCE by Codex when the session
   * starts, so it is immune to mtime drift from subsequent event
   * appends. That matters because an actively-running prior Codex
   * session in the same cwd would keep bumping its rollout mtime
   * forward, and an mtime-only filter would pick it instead of
   * ours. Combined with cwd matching, this gives us a precise
   * "file created by this exact spawn" check.
   *
   * Known limitation: two concurrent spawns in the same cwd (no
   * worktrees) within 1s of each other could both match - use
   * worktrees for reliable concurrent task support.
   */
  static async captureSessionIdFromFilesystem(options: {
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
    const captured = await this.captureSessionFromFilesystem(options);
    return captured?.id ?? null;
  }

  static async captureSessionFromFilesystem(options: {
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
  }): Promise<CapturedSession | null> {
    const context = options.rolloutRoot && options.preLaunchRollouts && options.launchStartedAt
      ? {
        processId: options.processId ?? 0,
        launchStartedAt: options.launchStartedAt,
        cwd: options.cwd,
        rolloutRoot: options.rolloutRoot,
        preLaunchRollouts: options.preLaunchRollouts,
        timeoutMs: options.timeoutMs ?? ((options.maxAttempts ?? 20) * 500),
      }
      : prepareCodexSessionCaptureContext({
        cwd: options.cwd,
        launchStartedAt: options.spawnedAt,
        processId: options.processId,
        timeoutMs: options.timeoutMs ?? ((options.maxAttempts ?? 20) * 500),
      });
    if (!options.preLaunchRollouts) {
      context.preLaunchRollouts = new Set();
    }

    try {
      return await captureCodexSessionFromRollout({
        ...context,
        maxAttempts: options.maxAttempts,
        onEvent: options.onEvent,
        shouldStop: options.shouldStop,
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'CAPTURE_TIMEOUT' || code === 'ROLLOUT_ROOT_UNAVAILABLE') return null;
      throw err;
    }
  }

  /**
   * Locate the rollout JSONL file for a known session UUID. Called
   * after the session ID has been captured (via fromFilesystem or
   * hooks). Polls for up to 5 seconds to cover disk write latency.
   *
   * The filename suffix contains the session UUID, so a single
   * readdirSync + regex match is sufficient - no cross-session
   * ambiguity.
   */
  static async locate(options: {
    agentSessionId: string;
    cwd: string;
  }): Promise<string | null> {
    const { agentSessionId } = options;
    // UTC date for the directory structure. Codex writes the file under
    // the current UTC date regardless of local timezone.
    const directory = codexSessionsDirForToday();
    // Embed the session UUID in the filename regex. Codex writes:
    //   rollout-<ISO-timestamp>-<sessionUUID>.jsonl
    // We don't know the timestamp prefix, but the UUID suffix is unique.
    const escapedId = agentSessionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^rollout-.*-${escapedId}\\.jsonl$`);

    const maxAttempts = 10;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const found = findMatchingFile(directory, pattern);
      if (found) return found;
      // On the first attempt, also check yesterday's dir in case the
      // session spans a UTC date rollover.
      if (attempt === 0) {
        const yesterday = codexSessionsDirForYesterday();
        if (yesterday !== directory) {
          const foundYesterday = findMatchingFile(yesterday, pattern);
          if (foundYesterday) return foundYesterday;
        }
      }
      await sleep(500);
    }
    return null;
  }

  /**
   * Parse newly-appended JSONL content (for append-only mode, Codex
   * isFullRewrite === false). Walks the entries in order and builds a
   * consolidated SessionHistoryParseResult representing the state after this
   * chunk. Usage fields are last-wins; events are append-only.
   */
  static parse(content: string, _mode: 'full' | 'append'): SessionHistoryParseResult {
    // State we accumulate across this chunk. Usage starts empty and
    // only gets populated if we see a relevant event.
    let modelId: string | undefined;
    let contextWindowSize: number | undefined;
    let totalInputTokens: number | undefined;
    let totalOutputTokens: number | undefined;
    let cachedInputTokens: number | undefined;
    const events: SessionEvent[] = [];
    let activity: Activity | null = null;

    // CRLF-tolerant split. Drops empty lines (final \n produces one).
    const lines = content.split(/\r?\n/).filter((line) => line.length > 0);

    for (const line of lines) {
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        // Malformed line (partial write mid-flush, corruption) - skip.
        continue;
      }
      if (!isRecord(entry)) continue;

      // Codex 0.118+ wraps lifecycle events (task_started, token_count,
      // task_complete, agent_message, user_message, ...) inside an
      // `event_msg` envelope. The real event name moved to `payload.type`
      // but the inner field layout (model_context_window, info.last_token_usage,
      // turn_id, ...) is unchanged. `response_item` and `turn_context` are
      // still emitted at the outer level, so the unwrap only fires when the
      // outer type is `event_msg` AND payload carries a `type` discriminator.
      const rawOuterType = entry.type;
      const payload = entry.payload;
      const rawDispatchType = rawOuterType === 'event_msg' && isRecord(payload) && typeof payload.type === 'string'
        ? payload.type
        : rawOuterType;
      // Narrow to the typed dispatch union. Unknown types (Codex
      // internal-only events we don't care about, future additions we
      // haven't taught the parser yet) are skipped silently here. The
      // typed `entryType` makes every comparison below a type-checked
      // string-literal match - mistyping a branch is a TS error.
      if (!isCodexDispatchType(rawDispatchType)) continue;
      const entryType: CodexDispatchType = rawDispatchType;
      const timestamp = parseTimestamp(entry.timestamp);

      if (entryType === 'turn_context' && isRecord(payload)) {
        const model = payload.model;
        if (typeof model === 'string' && model.length > 0) {
          modelId = model;
        }
      } else if (entryType === 'task_started' && isRecord(payload)) {
        const windowSize = payload.model_context_window;
        if (typeof windowSize === 'number' && windowSize > 0) {
          contextWindowSize = windowSize;
        }
        // task_started = agent is actively working on a turn.
        activity = Activity.Thinking;
      } else if (entryType === 'token_count' && isRecord(payload)) {
        const info = payload.info;
        if (isRecord(info)) {
          // IMPORTANT: use `last_token_usage`, NOT `total_token_usage`.
          // `total_token_usage.input_tokens` is cumulative billed input
          // across all turns and grows without bound. `last_token_usage`
          // is a per-turn snapshot of what was sent to the model on the
          // most recent turn, which is the authoritative measure of
          // current context occupancy. Verified empirically:
          //   total: 11214 → 22447 → 33693 (cumulative)
          //   last:  11214 → 11233 → 11246 (current context, grows slowly)
          // Using total would make the context % bar climb past 100% on
          // long sessions even though actual context barely changed.
          const lastTurn = info.last_token_usage;
          if (isRecord(lastTurn)) {
            const input = lastTurn.input_tokens;
            const output = lastTurn.output_tokens;
            const cached = lastTurn.cached_input_tokens;
            if (typeof input === 'number') totalInputTokens = input;
            if (typeof output === 'number') totalOutputTokens = output;
            if (typeof cached === 'number') cachedInputTokens = cached;
          }
          // task_started may have been missed if we joined mid-session;
          // prefer the live model_context_window if it's here too.
          const windowSize = info.model_context_window;
          if (typeof windowSize === 'number' && windowSize > 0) {
            contextWindowSize = windowSize;
          }
        }
      } else if (entryType === 'task_complete') {
        // Turn ended - agent is idle waiting for next prompt.
        activity = Activity.Idle;
      } else if (entryType === 'response_item' && isRecord(payload)) {
        const responseType = payload.type;
        if (responseType === 'function_call') {
          const toolName = typeof payload.name === 'string' ? payload.name : 'function';
          events.push({
            ts: timestamp,
            type: EventType.ToolStart,
            tool: mapCodexToolName(toolName),
            detail: toolName,
          });
        }
      }
    }

    // Build usage if we captured any token/model signal in this chunk.
    const usage = buildUsage({
      modelId,
      contextWindowSize,
      totalInputTokens,
      totalOutputTokens,
      cachedInputTokens,
    });

    return { usage, events, activity };
  }
}

// ---------- Internal helpers ----------

/**
 * Single source of truth for the Codex rollout entry types this parser
 * dispatches on. `event_msg` is intentionally absent - it's an envelope
 * that gets unwrapped to one of these inner types before dispatch, so it
 * never reaches the if/else chain. `session_meta` is also absent because
 * it's read separately by `captureSessionIdFromFilesystem` (first line
 * only) rather than through `parse()`.
 *
 * Adding a new entry type means: (1) add it here, (2) add an else-if
 * branch in `parse()`. TypeScript catches a typo in the branch literal
 * because the comparison narrows against `CodexDispatchType`.
 */
const CODEX_DISPATCH_TYPES = [
  'turn_context',
  'task_started',
  'token_count',
  'task_complete',
  'response_item',
] as const;

type CodexDispatchType = typeof CODEX_DISPATCH_TYPES[number];

function isCodexDispatchType(value: unknown): value is CodexDispatchType {
  return typeof value === 'string'
    && (CODEX_DISPATCH_TYPES as readonly string[]).includes(value);
}

/** Type guard for a plain JSON object (not null, not array). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse an ISO timestamp string into epoch ms; fall back to Date.now() on bad input. */
function parseTimestamp(value: unknown): number {
  if (typeof value !== 'string') return Date.now();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/**
 * Compute `~/.codex/sessions/<YYYY>/<MM>/<DD>/` using the current UTC
 * date. Cross-platform path construction via path.join.
 */
export function codexSessionsDirForToday(): string {
  const now = new Date();
  return codexSessionsDirForDate(now);
}

export function codexSessionsDirForYesterday(): string {
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return codexSessionsDirForDate(yesterday);
}

function codexSessionsDirForDate(date: Date): string {
  // toISOString() always returns UTC; slice(0, 10) → "YYYY-MM-DD".
  const iso = date.toISOString();
  const year = iso.slice(0, 4);
  const month = iso.slice(5, 7);
  const day = iso.slice(8, 10);
  return path.join(os.homedir(), '.codex', 'sessions', year, month, day);
}

/**
 * Find the first file in `directory` whose basename matches `pattern`.
 * Returns the absolute path, or null if the directory doesn't exist
 * or no file matches.
 */
export function findMatchingFile(directory: string, pattern: RegExp): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(directory);
  } catch {
    return null;
  }
  const match = entries.find((name) => pattern.test(name));
  return match ? path.join(directory, match) : null;
}

/** Simple async sleep helper for polling loops. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Map a Codex function_call name to Kangentic's AgentTool enum. The
 * enum only has two values (Bash, ExitPlanMode); any Codex tool call
 * that isn't an exit-plan action gets bucketed as Bash. Activity
 * tracking only cares about ToolStart/ToolEnd transitions, not the
 * specific tool identity, so this coarse mapping is sufficient.
 */
function mapCodexToolName(_name: string): AgentTool {
  return AgentTool.Bash;
}

/**
 * Build a sparse SessionUsage from the fields captured in a parse pass.
 * Returns null if no relevant fields were seen (avoids noisy no-op usage
 * updates).
 *
 * IMPORTANT: Only includes fields that were actually captured in this
 * chunk. Uncaptured fields are omitted entirely (not defaulted to 0) so
 * that the shallow spread merge in `UsageAccumulator.setSessionUsage()` does
 * not overwrite correct base values with zeros. For example, a chunk
 * containing only `turn_context` (model name) must NOT include
 * `contextWindowSize: 0` because that would overwrite a previously-set
 * window size from a `task_started` chunk.
 *
 * `usedPercentage` is never included - it's a derived value that
 * `setSessionUsage()` recalculates after merging, when both
 * `usedTokens` and `contextWindowSize` are available from potentially
 * different chunks.
 */
function buildUsage(captured: {
  modelId: string | undefined;
  contextWindowSize: number | undefined;
  totalInputTokens: number | undefined;
  totalOutputTokens: number | undefined;
  cachedInputTokens: number | undefined;
}): SessionUsage | null {
  const {
    modelId,
    contextWindowSize,
    totalInputTokens,
    totalOutputTokens,
    cachedInputTokens,
  } = captured;

  const hasModel = modelId !== undefined;
  const hasTokens = totalInputTokens !== undefined || totalOutputTokens !== undefined;
  if (!hasModel && !hasTokens && contextWindowSize === undefined) {
    return null;
  }

  // Build a sparse contextWindow with only captured fields. Keys that
  // are absent from this object will not overwrite existing base values
  // when spread-merged in setSessionUsage().
  const contextWindow: Record<string, number> = {};
  if (totalInputTokens !== undefined) {
    contextWindow.usedTokens = totalInputTokens;
    contextWindow.totalInputTokens = totalInputTokens;
  }
  if (totalOutputTokens !== undefined) {
    contextWindow.totalOutputTokens = totalOutputTokens;
  }
  if (cachedInputTokens !== undefined) {
    contextWindow.cacheTokens = cachedInputTokens;
  }
  if (contextWindowSize !== undefined) {
    contextWindow.contextWindowSize = contextWindowSize;
  }
  // Calculate usedPercentage only when both values are in THIS chunk.
  // When they arrive in separate chunks, setSessionUsage() recalculates
  // after merge. Including it here when possible avoids a brief 0%
  // flash on full-chunk scenarios (e.g. token_count with model_context_window).
  if (contextWindowSize !== undefined && contextWindowSize > 0 && totalInputTokens !== undefined) {
    contextWindow.usedPercentage = (totalInputTokens / contextWindowSize) * 100;
  }

  const result: Record<string, unknown> = {};
  if (Object.keys(contextWindow).length > 0) {
    result.contextWindow = contextWindow;
  }
  if (hasModel) {
    result.model = { id: modelId, displayName: modelId };
  }

  return result as unknown as SessionUsage;
}
