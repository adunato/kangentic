import { AgentDetector } from '../../shared/agent-detector';
import { standardUnixFallbackPaths } from '../../shared/fallback-paths';
import { interpolateTemplate } from '../../shared/template-utils';
import { quoteArg, isUnixLikeShell } from '../../../../shared/paths';
import { ActivityDetection } from '../../../../shared/types';
import type { AgentAdapter, AgentInfo, SpawnCommandOptions } from '../../agent-adapter';
import type {
  AgentPermissionEntry,
  AdapterRuntimeStrategy,
  PermissionMode,
  SubmissionContextType,
  SubmissionVerifier,
} from '../../../../shared/types';
import { locatePiSessionHistoryFile } from './session-history';

const PI_READ_ONLY_TOOLS = 'read,grep,find,ls';

/**
 * Pi coding-agent adapter.
 *
 * Pi is an interactive, PTY-first coding harness. It has no built-in
 * permission popups, hooks, or MCP client, so this MVP keeps runtime
 * integration deliberately small: caller-owned session IDs, deterministic
 * model/thinking flags, project-trust flags, and native session-file lookup.
 */
export class PiAdapter implements AgentAdapter {
  readonly name = 'pi';
  readonly displayName = 'Pi';
  readonly sessionType = 'pi_agent';
  readonly supportsCallerSessionId = true;

  readonly permissions: AgentPermissionEntry[] = [
    { mode: 'plan', label: 'Read-Only (Read Tools Only)' },
    { mode: 'default', label: 'Default (Ignore Project Files)' },
    { mode: 'acceptEdits', label: 'Accept Edits (Approve Project Files)' },
    { mode: 'bypassPermissions', label: 'Approve Project Files' },
  ];
  readonly defaultPermission: PermissionMode = 'default';

  readonly liveTelemetryUnsupported = {
    unavailableLabel: 'Telemetry: TUI only',
    unavailableTitle:
      'Pi does not expose a Kangentic status or event stream yet. '
      + 'Model, token, and cost telemetry are unavailable for Pi sessions.',
  };

  private readonly detector = new AgentDetector({
    binaryName: 'pi',
    fallbackPaths: standardUnixFallbackPaths('pi'),
    parseVersion: (raw) => {
      const match = raw.match(/(?:^|\s)v?(\d+\.\d+(?:\.\d+)*(?:[-+][\w.-]+)?)(?=\s|$)/i);
      return match?.[1] ?? null;
    },
  });

  async detect(overridePath?: string | null): Promise<AgentInfo> {
    return this.detector.detect(overridePath);
  }

  invalidateDetectionCache(): void {
    this.detector.invalidateCache();
  }

  // Pi's project trust is a CLI flag; no persistent trust file is changed by
  // Kangentic, so this method intentionally remains a no-op.
  async ensureTrust(_workingDirectory: string): Promise<void> {}

  buildCommand(options: SpawnCommandOptions): string {
    const { shell } = options;
    const parts: string[] = [quoteArg(options.agentPath, shell)];

    // `--session-id` is Pi's caller-owned identity surface. It is valid for
    // both a new session and an existing exact-id session; unlike --session,
    // --continue, and --resume, it must not be combined with another session
    // selector. `resume` is therefore intentionally not emitted.
    if (options.sessionId) {
      parts.push('--session-id', quoteArg(options.sessionId, shell));
    }

    if (options.model?.trim()) {
      parts.push('--model', quoteArg(options.model.trim(), shell));
    }
    if (options.effort?.trim()) {
      parts.push('--thinking', quoteArg(options.effort.trim(), shell));
    }

    // Pi has no permission prompts. Read-only mode is expressed through its
    // built-in tool allowlist. The default mode explicitly ignores project
    // local Pi resources for deterministic, non-interactive trust behavior;
    // approval-oriented modes opt into those resources.
    if (options.permissionMode === 'plan' || options.permissionMode === 'dontAsk') {
      parts.push('--tools', PI_READ_ONLY_TOOLS);
    }
    if (
      options.permissionMode === 'plan'
      || options.permissionMode === 'dontAsk'
      || options.permissionMode === 'default'
    ) {
      parts.push('--no-approve');
    } else if (
      options.permissionMode === 'acceptEdits'
      || options.permissionMode === 'auto'
      || options.permissionMode === 'bypassPermissions'
    ) {
      parts.push('--approve');
    }

    // Pi core has no MCP flag. pi-mcp-adapter can add --mcp-config, but the
    // current spawn contract supplies only a URL/token, not a safe config path;
    // leave core launches working and do not leak the token into argv/env.
    void options.mcpServerEnabled;
    void options.mcpServerUrl;
    void options.mcpServerToken;

    if (options.prompt) {
      const needsDoubleQuoteReplacement = shell
        ? !isUnixLikeShell(shell)
        : process.platform === 'win32';
      const safePrompt = needsDoubleQuoteReplacement
        ? options.prompt.replace(/"/g, "'")
        : options.prompt;
      parts.push(quoteArg(safePrompt, shell, { multiline: true }));
    }

    return parts.join(' ');
  }

  interpolateTemplate(template: string, variables: Record<string, string>): string {
    return interpolateTemplate(template, variables);
  }

  readonly runtime: AdapterRuntimeStrategy = {
    // Pi's TUI continuously redraws and does not expose a stable idle prompt
    // marker. Let the shared PTY silence timer provide the conservative idle
    // fallback rather than guessing from terminal paint artifacts.
    activity: ActivityDetection.pty(),
  };

  removeHooks(_directory: string): void {}

  clearSettingsCache(): void {}

  getExitSequence(): string[] {
    // Pi uses Ctrl+C once to cancel/clear and twice to exit the interactive
    // TUI. The second write is harmless if the process already exited.
    return ['\x03', '\x03'];
  }

  detectFirstOutput(data: string): boolean {
    return data.length > 0;
  }

  async locateSessionHistoryFile(agentSessionId: string, cwd: string): Promise<string | null> {
    return locatePiSessionHistoryFile(agentSessionId, cwd);
  }

  getSubmissionVerifier(_contextType: SubmissionContextType): SubmissionVerifier | null {
    // Pi's JSONL history is a tree format and does not yet have a measured,
    // safe submitted-text verifier for Kangentic command injection.
    return null;
  }
}
