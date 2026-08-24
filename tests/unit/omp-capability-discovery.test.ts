import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  exec: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock('node:util', () => ({
  promisify: (fn: unknown) => fn,
}));

import { exec, execFile } from 'node:child_process';
import { discoverOmpCapabilities } from '../../src/main/agent/adapters/omp/capability-discovery';

const execMock = vi.mocked(exec);
const execFileMock = vi.mocked(execFile);

function setHelp(stdout: string, stderr = ''): void {
  execMock.mockResolvedValue({ stdout, stderr });
  execFileMock.mockResolvedValue({ stdout, stderr });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('discoverOmpCapabilities', () => {
  it('discovers model override and advertised thinking choices from help', async () => {
    setHelp([
      'Usage: omp [options]',
      '  -m, --model <provider/model>  Model override',
      '  --thinking <low|medium|high>  Thinking effort',
    ].join('\n'));

    const result = await discoverOmpCapabilities('/opt/omp/bin/omp');

    expect(result.supportsModelOverride).toBe(true);
    expect(result.effortLevels).toEqual(['low', 'medium', 'high']);
  });

  it('deduplicates comma-separated thinking choices and ignores unsafe labels', async () => {
    setHelp('  --thinking [low, medium, low, HIGH, --bad]');
    const result = await discoverOmpCapabilities('/opt/omp/bin/omp');

    expect(result.effortLevels).toEqual(['low', 'medium', 'HIGH']);
  });

  it('reports model support without effort levels when thinking is not advertised', async () => {
    setHelp('  -m, --model <provider/model>  Model override\n');

    await expect(discoverOmpCapabilities('/opt/omp/bin/omp')).resolves.toEqual({
      supportsModelOverride: true,
    });
  });

  it('does not infer model support from unrelated help text', async () => {
    setHelp('  --model-name <name>  Display-only model name\n');

    await expect(discoverOmpCapabilities('/opt/omp/bin/omp')).resolves.toEqual({
      supportsModelOverride: false,
    });
  });

  it('returns empty capabilities when help execution fails', async () => {
    execMock.mockRejectedValue(new Error('not installed'));
    execFileMock.mockRejectedValue(new Error('not installed'));

    await expect(discoverOmpCapabilities('/missing/omp')).resolves.toEqual({});
  });
});
