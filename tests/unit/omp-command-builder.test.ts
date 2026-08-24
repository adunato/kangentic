import { describe, expect, it } from 'vitest';
import { OmpCommandBuilder } from '../../src/main/agent/adapters/omp/command-builder';
import type { OmpCommandOptions } from '../../src/main/agent/adapters/omp/command-builder';

function baseOptions(overrides: Partial<OmpCommandOptions> = {}): OmpCommandOptions {
  return {
    ompPath: '/opt/omp/bin/omp',
    taskId: 'task-omp',
    cwd: '/workspace/project',
    permissionMode: 'default',
    ...overrides,
  };
}

describe('OmpCommandBuilder', () => {
  it('builds a normal interactive command without synthetic integration flags', () => {
    const command = new OmpCommandBuilder().buildOmpCommand(baseOptions());

    expect(command).toContain('/opt/omp/bin/omp');
    expect(command).not.toContain('--approval-mode');
    expect(command).not.toContain('--profile');
    expect(command).not.toContain('--session');
    expect(command).not.toContain('--provider');
    expect(command).not.toContain('--mcp');
    expect(command).not.toContain('-p');
  });

  it('maps bypassPermissions to OMP yolo approval mode only', () => {
    const command = new OmpCommandBuilder().buildOmpCommand(
      baseOptions({ permissionMode: 'bypassPermissions' }),
    );

    expect(command).toContain('--approval-mode yolo');
    expect(command).not.toContain('--dangerously-skip-permissions');
  });

  it('passes model and thinking overrides without inventing a catalog or profile', () => {
    const command = new OmpCommandBuilder().buildOmpCommand(
      baseOptions({ model: ' anthropic/claude-sonnet-4-6 ', effort: ' high ' }),
    );

    expect(command).toContain('--model');
    expect(command).toContain('anthropic/claude-sonnet-4-6');
    expect(command).toContain('--thinking');
    expect(command).toContain('high');
    expect(command).not.toContain('--profile');
    expect(command).not.toContain('--provider');
  });

  it('uses print mode only for non-interactive calls', () => {
    const command = new OmpCommandBuilder().buildOmpCommand(
      baseOptions({ nonInteractive: true, prompt: 'summarize this' }),
    );

    expect(command).toContain(' -p ');
    expect(command).toContain('summarize this');
  });

  it('preserves safe multiline prompts and does not add a caller-owned session id', () => {
    const prompt = 'Review this change\nDo not reveal "secrets"';
    const command = new OmpCommandBuilder().buildOmpCommand(baseOptions({ prompt }));

    expect(command).toContain('Review this change');
    expect(command).toContain('Do not reveal');
    expect(command).not.toContain('--session');
    expect(command).not.toContain('task-omp');
  });

  it('fails closed for a missing resume session instead of launching relocation flow', () => {
    expect(() => new OmpCommandBuilder().buildOmpCommand(
      baseOptions({ resume: true, sessionId: 'missing-omp-session' }),
    )).toThrow(/resume refused/);
  });

  it('omits blank model and thinking values', () => {
    const command = new OmpCommandBuilder().buildOmpCommand(
      baseOptions({ model: '  ', effort: '\t' }),
    );

    expect(command).not.toContain('--model');
    expect(command).not.toContain('--thinking');
  });

  it('interpolates templates through the shared template utility', () => {
    expect(new OmpCommandBuilder().interpolateTemplate(
      'cwd={{cwd}} task={{taskId}}',
      { cwd: '/workspace/project', taskId: 'task-omp' },
    )).toBe('cwd=/workspace/project task=task-omp');
  });
});
