import type * as NodeFs from 'node:fs';
import type * as NodeOs from 'node:os';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const ompHomeOverride = vi.hoisted(() => 'C:\\Users\\omp-test-user');

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<NodeOs>();
  const homedir = (): string => ompHomeOverride;
  return { ...actual, default: { ...actual, homedir }, homedir };
});

vi.mock('which', () => ({
  default: vi.fn().mockResolvedValue('/opt/omp/bin/omp'),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<NodeFs>();
  return { ...actual, default: { ...actual, existsSync: vi.fn().mockReturnValue(true) } };
});

vi.mock('../../src/main/agent/shared/exec-version', () => ({
  execVersion: vi.fn().mockResolvedValue({ stdout: 'omp 18.0.4\n', stderr: '' }),
}));

import which from 'which';
import { execVersion } from '../../src/main/agent/shared/exec-version';
import { OmpDetector } from '../../src/main/agent/adapters/omp/detector';

const whichMock = vi.mocked(which);
const execVersionMock = vi.mocked(execVersion);

describe('OmpDetector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    whichMock.mockResolvedValue('/opt/omp/bin/omp');
    execVersionMock.mockResolvedValue({ stdout: 'omp 18.0.4\n', stderr: '' });
  });

  it('detects omp and parses the published 18.0.4 version', async () => {
    const result = await new OmpDetector().detect();

    expect(result).toEqual({ found: true, path: '/opt/omp/bin/omp', version: '18.0.4' });
  });
  it('parses the runtime slash version form from PATH discovery', async () => {
    execVersionMock.mockResolvedValue({ stdout: 'omp/18.0.4\n', stderr: '' });

    const result = await new OmpDetector().detect();

    expect(result).toEqual({ found: true, path: '/opt/omp/bin/omp', version: '18.0.4' });
  });

  it('accepts a leading v and prerelease suffix in version output', async () => {
    execVersionMock.mockResolvedValue({ stdout: 'v18.1.0-beta.1\n', stderr: '' });

    const result = await new OmpDetector().detect('/custom/omp');

    expect(result.version).toBe('18.1.0-beta.1');
    expect(result.path).toBe('/custom/omp');
    expect(whichMock).not.toHaveBeenCalled();
  });
  it('parses the runtime slash version form from an explicit override', async () => {
    execVersionMock.mockResolvedValue({ stdout: 'omp/18.0.4\n', stderr: '' });

    const result = await new OmpDetector().detect('/custom/omp.exe');

    expect(result).toEqual({ found: true, path: '/custom/omp.exe', version: '18.0.4' });
    expect(whichMock).not.toHaveBeenCalled();
  });

  it('uses an explicit override path without falling back to PATH on failure', async () => {
    execVersionMock.mockResolvedValue({ stdout: '', stderr: '' });

    const result = await new OmpDetector().detect('/custom/missing-omp');

    expect(result).toEqual({ found: false, path: '/custom/missing-omp', version: null });
    expect(whichMock).not.toHaveBeenCalled();
  });
  it.runIf(process.platform === 'win32')('falls back to the Bun user binary on Windows when PATH lookup fails', async () => {
    whichMock.mockRejectedValue(new Error('not found'));
    execVersionMock.mockResolvedValue({ stdout: 'omp/18.0.4\n', stderr: '' });
    const fallbackPath = path.join(os.homedir(), '.bun', 'bin', 'omp.exe');

    const result = await new OmpDetector().detect();

    expect(result).toEqual({ found: true, path: fallbackPath, version: '18.0.4' });
    expect(whichMock).toHaveBeenCalledWith('omp');
    expect(execVersionMock).toHaveBeenCalledWith(fallbackPath);
  });

  it('shares concurrent detection and invalidates the cached result', async () => {
    const detector = new OmpDetector();
    const results = await Promise.all([detector.detect(), detector.detect(), detector.detect()]);
    expect(results.every((result) => result.found)).toBe(true);
    expect(execVersionMock).toHaveBeenCalledTimes(1);

    detector.invalidateCache();
    await detector.detect();
    expect(execVersionMock).toHaveBeenCalledTimes(2);
  });
});
