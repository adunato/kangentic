import { quoteArg, isUnixLikeShell } from '../../../../shared/paths';
import { interpolateTemplate } from '../../shared/template-utils';
import type { PermissionMode } from '../../../../shared/types';
import { assertOmpResumeSession } from './session-history-parser';

export interface OmpCommandOptions {
  ompPath: string;
  taskId: string;
  prompt?: string;
  cwd: string;
  permissionMode: PermissionMode;
  projectRoot?: string;
  sessionId?: string;
  resume?: boolean;
  nonInteractive?: boolean;
  statusOutputPath?: string;
  eventsOutputPath?: string;
  shell?: string;
  mcpServerEnabled?: boolean;
  mcpServerUrl?: string;
  mcpServerToken?: string;
  model?: string;
  effort?: string;
}

/**
 * Build an OMP invocation using only native, documented CLI controls.
 * OMP owns profiles, provider sessions, MCP configuration, and cwd
 * inheritance; Kangentic deliberately does not shadow any of those layers.
 */
export class OmpCommandBuilder {
  buildOmpCommand(options: OmpCommandOptions): string {
    const { shell } = options;
    const parts = [quoteArg(options.ompPath, shell)];
    if (options.resume && !options.sessionId) {
      throw new Error('OMP resume requested without an OMP session id');
    }
    const isResume = Boolean(options.resume && options.sessionId);

    if (isResume) {
      // Resume must never fall through to OMP's interactive relocation prompt.
      // This synchronous preflight is intentionally fail-closed when the file
      // is missing, malformed, or belongs to a different cwd.
      assertOmpResumeSession(options.sessionId!, options.cwd);
      parts.push('--resume', quoteArg(options.sessionId!, shell));
    }

    if (options.permissionMode === 'bypassPermissions') {
      parts.push('--approval-mode', 'yolo');
    }

    if (options.model?.trim()) {
      parts.push('--model', quoteArg(options.model.trim(), shell));
    }
    if (options.effort?.trim()) {
      parts.push('--thinking', quoteArg(options.effort.trim(), shell));
    }

    // The regular task launch is interactive. A transient/non-interactive
    // caller gets OMP's print mode; no session/profile/provider flags are
    // synthesized here.
    if (options.nonInteractive) parts.push('-p');

    if (!isResume && options.prompt) {
      const needsDoubleQuoteReplacement = shell
        ? !isUnixLikeShell(shell)
        : process.platform === 'win32';
      const safePrompt = needsDoubleQuoteReplacement
        ? options.prompt.replace(/"/g, "'")
        : options.prompt;
      parts.push(quoteArg(safePrompt, shell, { multiline: true }));
    }

    // OMP MCP configuration is native. The generic launch contract still
    // carries these values for other adapters, but OMP must not inject a
    // project config or leak a token through argv/environment.
    void options.taskId;
    void options.projectRoot;
    void options.statusOutputPath;
    void options.eventsOutputPath;
    void options.mcpServerEnabled;
    void options.mcpServerUrl;
    void options.mcpServerToken;

    return parts.join(' ');
  }

  interpolateTemplate(template: string, variables: Record<string, string>): string {
    return interpolateTemplate(template, variables);
  }
}
