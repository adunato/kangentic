import { ActivityDetection } from '../../../../shared/types';
import type {
  AgentCapabilities,
  AgentPermissionEntry,
  AdapterRuntimeStrategy,
  PermissionMode,
  SubmissionContextType,
  SubmissionVerifier,
} from '../../../../shared/types';
import type {
  AgentAdapter,
  AgentInfo,
  ParsedTranscript,
  ParsedTranscriptWindow,
  SettingsChangeSpec,
  SpawnCommandOptions,
} from '../../agent-adapter';
import { runCliPrintSummarize, buildSummarizePrompt } from '../../shared/auto-name';
import { OmpCommandBuilder } from './command-builder';
import { discoverOmpCapabilities } from './capability-discovery';
import { OmpDetector } from './detector';
import {
  captureOmpSessionFromFilesystem,
  locateOmpSessionFile,
  parseOmpSessionHistory,
} from './session-history-parser';
import {
  locateOmpTranscriptFile,
  parseOmpTranscript,
  parseOmpTranscriptWindow,
} from './transcript-parser';

/** Oh My Pi adapter. Native profile, MCP, authentication, and storage remain OMP-owned. */
export class OmpAdapter implements AgentAdapter {
  readonly name = 'omp';
  readonly displayName = 'Oh My Pi';
  readonly sessionType = 'omp_agent';
  readonly supportsCallerSessionId = false;

  readonly permissions: AgentPermissionEntry[] = [
    { mode: 'default', label: 'Default' },
    { mode: 'bypassPermissions', label: 'YOLO (Auto-Approve All)' },
  ];
  readonly defaultPermission: PermissionMode = 'default';

  private readonly detector = new OmpDetector();
  private readonly commandBuilder = new OmpCommandBuilder();

  async detect(overridePath?: string | null): Promise<AgentInfo> {
    return this.detector.detect(overridePath);
  }

  invalidateDetectionCache(): void {
    this.detector.invalidateCache();
  }

  async discoverCapabilities(cliPath: string, _forceRefresh?: boolean): Promise<AgentCapabilities> {
    return discoverOmpCapabilities(cliPath);
  }

  async ensureTrust(_workingDirectory: string): Promise<void> {
    // OMP's trust/profile/auth state is native and must not be rewritten by
    // Kangentic. Launching with the inherited cwd is the complete integration.
  }

  buildCommand(options: SpawnCommandOptions): string {
    const { agentPath, model, effort, ...rest } = options;
    return this.commandBuilder.buildOmpCommand({
      ompPath: agentPath,
      model,
      effort,
      ...rest,
    });
  }

  interpolateTemplate(template: string, variables: Record<string, string>): string {
    return this.commandBuilder.interpolateTemplate(template, variables);
  }

  readonly runtime: AdapterRuntimeStrategy = {
    // OMP is a full-screen TUI without a stable prompt marker. The shared PTY
    // silence detector is the conservative activity source.
    activity: ActivityDetection.pty(),
    sessionId: {
      // OMP does not print a durable session id in its startup UI. Capture the
      // v3 file created for this exact cwd and launch instead.
      fromFilesystem: captureOmpSessionFromFilesystem,
    },
    sessionHistory: {
      locate: async ({ agentSessionId, cwd }) => locateOmpSessionFile(agentSessionId, cwd),
      parse: parseOmpSessionHistory,
      isFullRewrite: false,
    },
  };

  removeHooks(_directory: string, _taskId?: string): void {
    // OMP has no Kangentic-owned hooks.
  }

  clearSettingsCache(): void {
    // OMP has no Kangentic settings cache.
  }

  getExitSequence(): string[] {
    // Ctrl+C is the only shutdown write already supported by the PTY lifecycle;
    // no unverified OMP slash command is sent.
    return ['\x03'];
  }

  detectFirstOutput(data: string): boolean {
    return data.length > 0;
  }

  async locateSessionHistoryFile(agentSessionId: string, cwd: string): Promise<string | null> {
    return locateOmpSessionFile(agentSessionId, cwd);
  }

  async parseTranscript(agentSessionId: string, cwd: string): Promise<ParsedTranscript> {
    const filePath = await locateOmpTranscriptFile(agentSessionId, cwd);
    if (!filePath) return { entries: [], sourcePath: null };
    return { entries: await parseOmpTranscript(filePath), sourcePath: filePath };
  }

  async summarize(prompt: string, cliPath: string, cwd: string): Promise<string> {
    return runCliPrintSummarize({
      cliPath,
      args: ['-p', '--no-session', '--no-title', '--no-tools'],
      prompt: buildSummarizePrompt(prompt),
      cwd,
    });
  }

  async parseTranscriptWindow(
    agentSessionId: string,
    cwd: string,
    startByte: number,
    maxBytes: number,
  ): Promise<ParsedTranscriptWindow> {
    const filePath = await locateOmpTranscriptFile(agentSessionId, cwd);
    if (!filePath) {
      return { entries: [], sourcePath: null, nextByteOffset: 0, totalBytes: 0 };
    }
    const window = await parseOmpTranscriptWindow(filePath, startByte, maxBytes);
    return { ...window, sourcePath: filePath };
  }

  getSubmissionVerifier(_contextType: SubmissionContextType): SubmissionVerifier | null {
    // OMP's command and prompt handling are TUI-local; no bounded native
    // submission verifier is assumed until it is proven against v3 history.
    return null;
  }

  canVerifySlashSubmission(): boolean {
    return false;
  }

  getInjectionSequence(_spec: SettingsChangeSpec): string[] {
    // Model/thinking overrides are launch-time controls. OMP has no proven
    // live command injection path for either setting.
    return [];
  }

}
