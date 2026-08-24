import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/main/agent/shared/auto-name', () => ({
  buildSummarizePrompt: vi.fn((prompt: string) => `SUMMARIZE:${prompt}`),
  runCliPrintSummarize: vi.fn().mockResolvedValue('A concise title'),
}));

import { OmpAdapter } from '../../src/main/agent/adapters/omp';
import { buildSummarizePrompt, runCliPrintSummarize } from '../../src/main/agent/shared/auto-name';
import type { SpawnCommandOptions } from '../../src/main/agent/agent-adapter';

const OMP_STARTUP_FIXTURE = fs.readFileSync(
  path.join(__dirname, '..', 'fixtures', 'agent-pty', 'omp.txt'),
  'utf8',
);

function options(overrides: Partial<SpawnCommandOptions> = {}): SpawnCommandOptions {
  return {
    agentPath: '/opt/omp/bin/omp',
    taskId: 'task-omp',
    cwd: '/workspace/project',
    permissionMode: 'default',
    ...overrides,
  };
}

describe('OmpAdapter', () => {
  let adapter: OmpAdapter;

  beforeEach(() => {
    adapter = new OmpAdapter();
    vi.clearAllMocks();
  });

  it('exposes stable OMP identity and caller-session ownership', () => {
    expect(adapter.name).toBe('omp');
    expect(adapter.displayName).toBe('Oh My Pi');
    expect(adapter.sessionType).toBe('omp_agent');
    expect(adapter.supportsCallerSessionId).toBe(false);
  });

  it('exposes only default and YOLO permissions with default selected', () => {
    expect(adapter.permissions).toEqual([
      { mode: 'default', label: 'Default' },
      { mode: 'bypassPermissions', label: 'YOLO (Auto-Approve All)' },
    ]);
    expect(adapter.defaultPermission).toBe('default');
  });

  it('builds through the OMP command builder and maps launch controls', () => {
    const command = adapter.buildCommand(options({
      permissionMode: 'bypassPermissions',
      model: 'provider/model',
      effort: 'medium',
    }));

    expect(command).toContain('--approval-mode yolo');
    expect(command).toContain('--model');
    expect(command).toContain('provider/model');
    expect(command).toContain('--thinking');
    expect(command).toContain('medium');
  });

  it('uses conservative activity and any nonempty first output for the full-screen TUI', () => {
    expect(adapter.runtime.activity).toMatchObject({ kind: 'pty' });
    expect(adapter.detectFirstOutput('omp boot')).toBe(true);
    expect(adapter.detectFirstOutput('')).toBe(false);
    expect(adapter.getExitSequence()).toEqual(['\x03']);
  });

  it('accepts the measured full-screen startup frames without an idle detector', () => {
    const startupFrames = OMP_STARTUP_FIXTURE.split(/\n{2,}/).filter((frame) => frame.trim().length > 0);
    const activity = adapter.runtime.activity;

    // These are stable terminal structures from the captured startup, not
    // account/model/cwd decorations.
    expect(OMP_STARTUP_FIXTURE).toMatch(/^╭─── omp v/m);
    expect(OMP_STARTUP_FIXTURE).toContain('Welcome back!');
    expect(OMP_STARTUP_FIXTURE).toMatch(/╭── π\s+>/);
    expect(OMP_STARTUP_FIXTURE).toContain('LSP Servers');
    expect(OMP_STARTUP_FIXTURE).toContain('Connecting to MCP servers:');
    expect(OMP_STARTUP_FIXTURE).toContain('Connected to MCP servers:');

    expect(startupFrames.length).toBeGreaterThan(2);
    expect(startupFrames.every((frame) => adapter.detectFirstOutput(frame))).toBe(true);
    expect(activity.kind).toBe('pty');
    if (activity.kind === 'pty') {
      // OMP redraws the prompt repeatedly while MCP connects. Activity must
      // remain the conservative PTY/silence decision, not oscillate on UI text.
      expect(activity.detectIdle).toBeUndefined();
    }
  });

  it('does not expose injection or slash-submission verification paths', () => {
    const unchangedSettings = { model: null, modelChanged: false, effort: null, effortChanged: false };
    expect(adapter.getInjectionSequence(unchangedSettings)).toEqual([]);
    expect(adapter.getSubmissionVerifier('paste')).toBeNull();
    expect(adapter.canVerifySlashSubmission()).toBe(false);
  });

  it('constructs summarize invocation with isolated no-session print flags', async () => {
    await expect(adapter.summarize('fix the login timeout', '/opt/omp/bin/omp', '/workspace/project'))
      .resolves.toBe('A concise title');

    expect(buildSummarizePrompt).toHaveBeenCalledWith('fix the login timeout');
    expect(runCliPrintSummarize).toHaveBeenCalledWith({
      cliPath: '/opt/omp/bin/omp',
      args: ['-p', '--no-session', '--no-title', '--no-tools'],
      prompt: 'SUMMARIZE:fix the login timeout',
      cwd: '/workspace/project',
    });
  });

  it('keeps trust, hooks, settings, and live overrides native to OMP', async () => {
    await expect(adapter.ensureTrust('/workspace/project')).resolves.toBeUndefined();
    expect(() => adapter.removeHooks('/workspace/project', 'task-omp')).not.toThrow();
    expect(() => adapter.clearSettingsCache()).not.toThrow();
    expect(adapter.getInjectionSequence({ model: null, modelChanged: false, effort: null, effortChanged: false })).toEqual([]);
  });
});
