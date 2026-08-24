/**
 * Focused unit coverage for the Pi adapter: detection, command construction,
 * runtime identity, native session lookup, and registry/display integration.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { SpawnCommandOptions } from '../../src/main/agent/agent-adapter';
import type { PermissionMode } from '../../src/shared/types';
import {
  agentDisplayName,
  agentShortName,
  agentInstallUrl,
} from '../../src/renderer/utils/agent-display-name';

let mockWhichResult: string | Error = '/usr/bin/pi';
let mockExecVersionStdout = 'pi 0.79.2\n';
let mockExecVersionShouldFail = false;
let mockExistsSyncReturnValue = true;
let execVersionCallCount = 0;

vi.mock('which', () => ({
  default: async () => {
    if (mockWhichResult instanceof Error) throw mockWhichResult;
    return mockWhichResult;
  },
}));

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    default: {
      ...original,
      existsSync: () => mockExistsSyncReturnValue,
    },
  };
});

vi.mock('../../src/main/agent/shared/exec-version', () => ({
  execVersion: async () => {
    execVersionCallCount++;
    if (mockExecVersionShouldFail) throw new Error('command not found');
    return { stdout: mockExecVersionStdout, stderr: '' };
  },
}));

const { PiAdapter } = await import('../../src/main/agent/adapters/pi');

function makeOptions(overrides: Partial<SpawnCommandOptions> = {}): SpawnCommandOptions {
  return {
    agentPath: '/usr/bin/pi',
    taskId: 'task-1',
    cwd: '/projects/my-app',
    permissionMode: 'default',
    ...overrides,
  };
}

describe('PiAdapter', () => {
  let adapter: InstanceType<typeof PiAdapter>;

  beforeEach(() => {
    adapter = new PiAdapter();
    mockWhichResult = '/usr/bin/pi';
    mockExecVersionStdout = 'pi 0.79.2\n';
    mockExecVersionShouldFail = false;
    mockExistsSyncReturnValue = true;
    execVersionCallCount = 0;
  });

  it('declares Pi identity and caller-owned session IDs', () => {
    expect(adapter.name).toBe('pi');
    expect(adapter.displayName).toBe('Pi');
    expect(adapter.sessionType).toBe('pi_agent');
    expect(adapter.supportsCallerSessionId).toBe(true);
    expect(adapter.defaultPermission).toBe('default');
    expect(adapter.runtime.sessionId).toBeUndefined();
    expect(adapter.runtime.sessionHistory).toBeUndefined();
  });

  describe('detect', () => {
    it('parses Pi version output through the shared detector', async () => {
      const result = await adapter.detect();
      expect(result).toEqual({ found: true, path: '/usr/bin/pi', version: '0.79.2' });
    });

    it('honors an override path and caches the result', async () => {
      const first = await adapter.detect('/custom/pi');
      const second = await adapter.detect('/custom/pi');
      expect(first).toEqual({ found: true, path: '/custom/pi', version: '0.79.2' });
      expect(second).toBe(first);
      expect(execVersionCallCount).toBe(1);
    });

    it('reports a failed override without falling back to PATH', async () => {
      mockExecVersionShouldFail = true;
      const result = await adapter.detect('/custom/pi');
      expect(result).toEqual({ found: false, path: '/custom/pi', version: null });
    });
  });

  describe('buildCommand', () => {
    it('passes prompt, model, thinking, caller session, and default trust flags', () => {
      const command = adapter.buildCommand(makeOptions({
        prompt: 'Fix the "broken" test',
        model: 'anthropic/claude-sonnet',
        effort: 'xhigh',
        sessionId: 'pi-session-123',
        resume: true,
        mcpServerEnabled: true,
        mcpServerUrl: 'http://127.0.0.1:1234/mcp/project',
        mcpServerToken: 'secret-token',
      }));

      expect(command).toContain('--session-id');
      expect(command).toContain('pi-session-123');
      expect(command).toContain('--model');
      expect(command).toContain('anthropic/claude-sonnet');
      expect(command).toContain('--thinking');
      expect(command).toContain('xhigh');
      expect(command).toContain('Fix the');
      expect(command).toContain('--no-approve');
      expect(command).not.toContain('--session ');
      expect(command).not.toContain('--continue');
      expect(command).not.toContain('--resume');
      expect(command).not.toContain('--mcp-config');
      expect(command).not.toContain('secret-token');
    });

    it('uses Pi read-only tools for plan mode', () => {
      const command = adapter.buildCommand(makeOptions({ permissionMode: 'plan' }));
      expect(command).toContain('--tools read,grep,find,ls');
      expect(command).toContain('--no-approve');
      expect(command).not.toContain('--approve');
    });

    it('approves project-local resources for edit-capable modes', () => {
      const editModes: PermissionMode[] = ['acceptEdits', 'auto', 'bypassPermissions'];
      for (const permissionMode of editModes) {
        const command = adapter.buildCommand(makeOptions({ permissionMode }));
        expect(command).toContain('--approve');
        expect(command).not.toContain('--no-approve');
      }
    });

    it('preserves multiline prompts and adapts quotes for Windows shells', () => {
      const command = adapter.buildCommand(makeOptions({
        prompt: 'Fix the "broken" test\nthen run it',
        shell: 'powershell',
      }));
      expect(command).not.toContain('"broken"');
      expect(command).toContain("'broken'");
      expect(command).toContain('then run it');
    });
  });

  it('uses PTY activity fallback and a double-Ctrl+C exit sequence', () => {
    expect(adapter.runtime.activity.kind).toBe('pty');
    expect(adapter.detectFirstOutput('Pi is ready')).toBe(true);
    expect(adapter.detectFirstOutput('')).toBe(false);
    expect(adapter.getExitSequence()).toEqual(['\x03', '\x03']);
    expect(adapter.liveTelemetryUnsupported?.unavailableLabel).toBe('Telemetry: TUI only');
  });

  it('locates current Pi session filenames under a configured session root', async () => {
    const tempRoot = fs.mkdtempSync(path.join(process.cwd(), '.pi-adapter-test-'));
    const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
    try {
      const cwd = path.join(tempRoot, 'project');
      const sessionRoot = path.join(tempRoot, 'sessions');
      const resolvedCwd = path.resolve(cwd);
      const encodedCwd = `--${resolvedCwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
      const sessionDirectory = path.join(sessionRoot, encodedCwd);
      const sessionId = '0190abcd-1234-7abc-8def-0123456789ab';
      const sessionPath = path.join(sessionDirectory, `2026-08-21T12-00-00.000Z_${sessionId}.jsonl`);
      fs.mkdirSync(sessionDirectory, { recursive: true });
      fs.writeFileSync(sessionPath, '{"type":"session","id":"session"}\n');
      process.env.PI_CODING_AGENT_SESSION_DIR = sessionRoot;

      await expect(adapter.locateSessionHistoryFile(sessionId, cwd)).resolves.toBe(sessionPath);
    } finally {
      if (previousSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
      else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('returns null when the Pi session file is absent', async () => {
    const tempRoot = fs.mkdtempSync(path.join(process.cwd(), '.pi-adapter-test-'));
    const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
    try {
      process.env.PI_CODING_AGENT_SESSION_DIR = path.join(tempRoot, 'sessions');
      await expect(adapter.locateSessionHistoryFile('missing-session', path.join(tempRoot, 'project')))
        .resolves.toBeNull();
    } finally {
      if (previousSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
      else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('keeps hook/settings and submission-verification methods as safe no-ops', async () => {
    await expect(adapter.ensureTrust('/some/dir')).resolves.toBeUndefined();
    expect(() => adapter.removeHooks('/some/dir')).not.toThrow();
    expect(() => adapter.clearSettingsCache()).not.toThrow();
    expect(adapter.getSubmissionVerifier('paste')).toBeNull();
    expect(adapter.getSubmissionVerifier('command-injection')).toBeNull();
    expect(adapter.interpolateTemplate('Fix {{issue}}', { issue: 'bug-123' })).toBe('Fix bug-123');
  });
});

describe('Pi registration and display metadata', () => {
  it('registers Pi as a built-in adapter', async () => {
    const { agentRegistry } = await import('../../src/main/agent/agent-registry');
    expect(agentRegistry.getOrThrow('pi').sessionType).toBe('pi_agent');
    expect(agentRegistry.getBySessionType('pi_agent')?.name).toBe('pi');
    expect(agentRegistry.list()).toContain('pi');
  });

  it('exposes Pi display metadata', () => {
    expect(agentDisplayName('pi')).toBe('Pi');
    expect(agentShortName('pi')).toBe('Pi');
    expect(agentInstallUrl('pi')).toBe('https://pi.dev');
  });
});
