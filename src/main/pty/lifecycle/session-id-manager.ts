import crypto from 'node:crypto';
import { stripAnsiEscapes } from '../buffer/transcript-writer';
import type { AgentParser, CapturedSession, SessionCaptureContext, SessionCaptureEventName } from '../../../shared/types';

type FilesystemCaptureStrategy = NonNullable<NonNullable<AgentParser['runtime']['sessionId']>['fromFilesystem']>;

/**
 * Chunk-boundary-safe scanner for extracting agent session IDs from PTY output.
 *
 * PTY data arrives in arbitrary chunks. On Windows ConPTY that flushes at
 * ~4KB boundaries, a UUID printed at exactly the boundary splits across two
 * chunks and a per-chunk regex misses it. This scanner maintains a rolling
 * window (default 8KB = 2x ConPTY chunk size) of the most recent output and
 * runs the adapter's regex against the concatenation, so matches spanning any
 * single chunk boundary are preserved.
 *
 * ANSI escape sequences are stripped before matching so Windows ConPTY
 * cursor-positioning that interleaves with printable characters doesn't
 * break regexes that work on Unix pty.
 *
 * Used exclusively by SessionIdManager below. Exported so tests can
 * drive it directly against edge cases.
 */
export class SessionIdScanner {
  /** Rolling buffer of the most recent PTY output (capped at `bufferMax`). */
  private buffer = '';

  constructor(private readonly bufferMax: number = 8192) {}

  /**
   * Feed a raw PTY chunk. Returns the captured session ID on first match,
   * or null. Caller should stop invoking after a non-null return.
   */
  scanChunk(data: string, fromOutput: (d: string) => string | null): string | null {
    let combined = this.buffer + data;
    if (combined.length > this.bufferMax) {
      combined = combined.slice(combined.length - this.bufferMax);
    }
    this.buffer = combined;
    return fromOutput(stripAnsiEscapes(combined));
  }

  /**
   * Scan a full scrollback buffer once at suspend time. Does not mutate
   * the rolling buffer. Used as the last-resort fallback after the PTY exits.
   */
  scanScrollback(scrollback: string, fromOutput: (d: string) => string | null): string | null {
    return fromOutput(stripAnsiEscapes(scrollback));
  }

  /** Free the rolling buffer once a capture has succeeded. */
  reset(): void {
    this.buffer = '';
  }
}

export interface SessionIdManagerCallbacks {
  hasAgentSessionId(sessionId: string): boolean;
  notifyAgentSessionId(sessionId: string, capturedId: string, capture?: CapturedSession): void;
  /** True if the session is still in the SessionManager map. Used to
   *  avoid logging a capture for a session that was killed while the
   *  filesystem promise was in flight. */
  sessionExists(sessionId: string): boolean;
  trackCaptureEvent?(name: SessionCaptureEventName, props: Record<string, string | number | boolean>): void;
}

/**
 * Coordinates the pathways by which SessionManager learns an agent's
 * internal session ID (the value passed to `--resume`).
 *
 * Pathways, tried concurrently after they are armed - first to produce a non-null ID wins:
 *   1. Filesystem - adapter polls a DB or rollout file (fire-and-forget
 *      Promise). Primary path for Codex 0.118 where PTY output and
 *      hooks are both unavailable.
 *   2. Stream/output - per-chunk rolling-buffer scanner matches a
 *      regex across chunk boundaries. Primary path for Claude.
 *   3. Scrollback fallback - at suspend time, scan the whole
 *      scrollback once. Catches late prints (Gemini's on-exit banner,
 *      Codex startup headers that the stream scanner missed).
 *   4. Hook (not handled here) - Claude Code's SessionStart hook
 *      writes the ID to status.json; read by StatusFileReader.
 *
 * Additionally, arm a 30s diagnostic timer when capture is expected. Codex is
 * special: its native rollout and output capture are deferred until Kangentic
 * submits the first task to the idle TUI, so an empty startup never becomes
 * resumable and never logs a false startup warning.
 */
export class SessionIdManager {
  /** Rolling buffer size for session-ID capture. Must be at least 2x the max
   *  PTY chunk size so any UUID straddling a single chunk boundary is preserved
   *  after slicing. Windows ConPTY flushes at 4KB, so 8KB gives a safe margin. */
  private static readonly BUFFER_MAX = 8192;
  /** Warn if capture hasn't fired by this timeout. */
  private static readonly DIAGNOSTIC_TIMEOUT_MS = 30_000;

  private scanners = new Map<string, SessionIdScanner>();
  private diagnosticTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private filesystemCaptureStarted = new Set<string>();
  private filesystemCaptureStopped = new Set<string>();
  private captureContexts = new Map<string, {
    agentName: string;
    processId: number;
    cwd: string;
    startedAt: number;
  }>();

  constructor(private readonly callbacks: SessionIdManagerCallbacks) {}

  /**
   * Initialize capture bookkeeping at spawn time. For most adapters this also
   * arms the diagnostic timer and filesystem capture. Codex defers native
   * capture until beginPostFirstTaskCapture(), because an empty TUI has not yet
   * created the resumable session Kangentic cares about.
   *
   * `hasKnownAgentSessionId` lets the caller indicate that the agent
   * session ID is already known at spawn time (caller-owned UUID via
   * `--session-id` etc). When true, the diagnostic "not captured"
   * timer is skipped because the ID is fixed by us, not discovered
   * by the agent.
   */
  init(
    sessionId: string,
    agentParser: AgentParser | undefined,
    cwd: string,
    agentName: string,
    hasKnownAgentSessionId: boolean = false,
    captureContext?: SessionCaptureContext,
  ): void {
    const strategy = agentParser?.runtime?.sessionId;
    if (!strategy) return;
    const processId = captureContext?.processId ?? 0;
    this.captureContexts.set(sessionId, {
      agentName,
      processId,
      cwd,
      startedAt: Date.now(),
    });

    if (agentName === 'codex') return;

    const hasCapturePath = !!(strategy.fromHook || strategy.fromOutput || strategy.fromFilesystem);
    if (hasCapturePath && !hasKnownAgentSessionId) {
      this.armDiagnosticTimer(sessionId, agentName, false);
    }

    this.startFilesystemCapture(sessionId, strategy.fromFilesystem, cwd, agentName, processId, captureContext, false);
  }

  /**
   * Start native Codex capture when Kangentic is about to submit the first task
   * into the already-running TUI. The rollout snapshot is supplied by the caller
   * from that exact point in time. Repeat calls are ignored once capture has
   * started, completed, or an ID is already known.
   */
  beginPostFirstTaskCapture(
    sessionId: string,
    agentParser: AgentParser | undefined,
    cwd: string,
    agentName: string,
    captureContext: SessionCaptureContext,
  ): void {
    if (agentName !== 'codex') return;
    const strategy = agentParser?.runtime?.sessionId;
    if (!strategy) return;
    if (this.callbacks.hasAgentSessionId(sessionId)) return;
    if (this.filesystemCaptureStarted.has(sessionId)) return;

    this.filesystemCaptureStopped.delete(sessionId);
    this.filesystemCaptureStarted.add(sessionId);
    this.captureContexts.set(sessionId, {
      agentName,
      processId: captureContext.processId ?? 0,
      cwd,
      startedAt: Date.now(),
    });

    this.armDiagnosticTimer(sessionId, agentName, true);
    this.startFilesystemCapture(
      sessionId,
      strategy.fromFilesystem,
      cwd,
      agentName,
      captureContext.processId ?? 0,
      captureContext,
      true,
    );
  }

  /**
   * Feed a fresh PTY chunk into the per-session rolling-buffer scanner.
   * No-op if the adapter has no `fromOutput` strategy, or if the ID has
   * already been captured via another pathway.
   */
  onData(sessionId: string, data: string, agentParser: AgentParser | undefined): void {
    const fromOutput = agentParser?.runtime?.sessionId?.fromOutput;
    if (!fromOutput) return;
    if (this.callbacks.hasAgentSessionId(sessionId)) return;
    const context = this.captureContexts.get(sessionId);
    if (context?.agentName === 'codex' && !this.filesystemCaptureStarted.has(sessionId)) return;

    let scanner = this.scanners.get(sessionId);
    if (!scanner) {
      scanner = new SessionIdScanner(SessionIdManager.BUFFER_MAX);
      this.scanners.set(sessionId, scanner);
    }
    const capturedId = scanner.scanChunk(data, fromOutput);
    if (capturedId) {
      scanner.reset();
      this.callbacks.notifyAgentSessionId(sessionId, capturedId, this.captureForOutput(sessionId, capturedId));
    }
  }

  /**
   * Last-resort: scan the full scrollback for the agent session ID at
   * suspend time. Catches late prints (Gemini's on-exit banner) and
   * startup headers that the streaming scanner missed. No-op if the
   * ID has already been captured.
   */
  scanScrollback(
    sessionId: string,
    agentParser: AgentParser | undefined,
    rawScrollback: string,
  ): void {
    const fromOutput = agentParser?.runtime?.sessionId?.fromOutput;
    if (!fromOutput) return;
    if (this.callbacks.hasAgentSessionId(sessionId)) return;

    const scanner = this.scanners.get(sessionId) ?? new SessionIdScanner();
    const capturedId = scanner.scanScrollback(rawScrollback, fromOutput);
    if (capturedId) {
      this.callbacks.notifyAgentSessionId(sessionId, capturedId, this.captureForOutput(sessionId, capturedId));
    }
  }

  /**
   * Cancel the diagnostic timer without dropping the scanner. Called
   * from the PTY exit handler so a spurious "not captured" warning
   * cannot fire after exit, but the scanner remains available for
   * the suspend-time scrollback fallback.
   */
  clearDiagnostic(sessionId: string): void {
    const timer = this.diagnosticTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.diagnosticTimers.delete(sessionId);
    }
    this.filesystemCaptureStopped.add(sessionId);
  }

  /** Full cleanup. Called on remove() and during respawn teardown. */
  removeSession(sessionId: string): void {
    this.clearDiagnostic(sessionId);
    this.scanners.delete(sessionId);
    this.filesystemCaptureStarted.delete(sessionId);
    this.filesystemCaptureStopped.delete(sessionId);
    this.captureContexts.delete(sessionId);
  }

  private armDiagnosticTimer(sessionId: string, agentName: string, afterFirstTask: boolean): void {
    if (this.diagnosticTimers.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.diagnosticTimers.delete(sessionId);
      if (!this.callbacks.hasAgentSessionId(sessionId)) {
        const timing = afterFirstTask
          ? 'session ID capture after first-task submission failed after '
          : 'session ID not captured after ';
        console.warn(
          `[session-manager] ${agentName} ${timing}`
          + `${SessionIdManager.DIAGNOSTIC_TIMEOUT_MS / 1000}s for session `
          + `${sessionId.slice(0, 8)} - --resume will not work.`,
        );
      }
    }, SessionIdManager.DIAGNOSTIC_TIMEOUT_MS);
    timer.unref();
    this.diagnosticTimers.set(sessionId, timer);
  }

  private startFilesystemCapture(
    sessionId: string,
    fromFilesystem: FilesystemCaptureStrategy | undefined,
    cwd: string,
    agentName: string,
    processId: number,
    captureContext: SessionCaptureContext | undefined,
    afterFirstTask: boolean,
  ): void {
    if (!fromFilesystem) return;
    const spawnedAt = captureContext?.launchStartedAt ?? new Date();
    fromFilesystem({
      spawnedAt,
      cwd,
      processId,
      launchStartedAt: captureContext?.launchStartedAt,
      rolloutRoot: captureContext?.rolloutRoot,
      preLaunchRollouts: captureContext?.preLaunchRollouts,
      timeoutMs: captureContext?.timeoutMs,
      onEvent: (name, props) => this.emitCaptureEvent(name, props),
      shouldStop: () => this.callbacks.hasAgentSessionId(sessionId)
        || !this.callbacks.sessionExists(sessionId)
        || this.filesystemCaptureStopped.has(sessionId),
    })
      .then((capturedId) => {
        if (!capturedId) return;
        const captured = normalizeCapturedSession(capturedId);
        if (this.callbacks.hasAgentSessionId(sessionId)) return;
        if (!this.callbacks.sessionExists(sessionId)) return;
        if (this.filesystemCaptureStopped.has(sessionId)) return;
        this.clearDiagnostic(sessionId);
        console.log(`[${agentName}] Captured session ID from filesystem: ${captured.id.slice(0, 16)}...`);
        this.callbacks.notifyAgentSessionId(
          sessionId,
          captured.id,
          agentName === 'codex' ? captured : undefined,
        );
      })
      .catch((err) => {
        const timing = afterFirstTask ? ' after first-task submission' : '';
        console.warn(`[session-manager] fromFilesystem capture${timing} failed for session=${sessionId.slice(0, 8)}:`, err);
      });
  }

  private captureForOutput(sessionId: string, capturedId: string): CapturedSession | undefined {
    const context = this.captureContexts.get(sessionId);
    if (context?.agentName !== 'codex') return undefined;
    const capture: CapturedSession = { id: capturedId, source: 'banner' };
    this.emitCaptureEvent('codex_session_id_captured', this.codexEventProps(context, {
      source: 'banner',
      candidateCount: 0,
      durationMs: Date.now() - context.startedAt,
    }));
    this.emitCaptureEvent('codex_session_capture_completed', this.codexEventProps(context, {
      source: 'banner',
      candidateCount: 0,
      durationMs: Date.now() - context.startedAt,
    }));
    return capture;
  }

  private codexEventProps(
    context: { agentName: string; processId: number; cwd: string },
    extra: Record<string, string | number | boolean>,
  ): Record<string, string | number | boolean> {
    return {
      agent: context.agentName,
      processId: context.processId,
      worktreeKey: worktreeKey(context.cwd),
      ...extra,
    };
  }

  private emitCaptureEvent(name: SessionCaptureEventName, props: Record<string, string | number | boolean>): void {
    this.callbacks.trackCaptureEvent?.(name, props);
  }
}

function normalizeCapturedSession(value: string | CapturedSession): CapturedSession {
  return typeof value === 'string'
    ? { id: value, source: 'rollout' }
    : value;
}

function worktreeKey(cwd: string): string {
  // Local-only stable key; avoids sending full user paths in telemetry.
  const normalized = process.platform === 'win32' ? cwd.toLowerCase() : cwd;
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}
