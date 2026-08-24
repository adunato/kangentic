import { describe, expect, it } from 'vitest';
import {
  agentDisplayName,
  agentInstallUrl,
  agentShortName,
} from '../../src/renderer/utils/agent-display-name';

describe('OMP agent display metadata', () => {
  it('presents the upstream install and stable renderer labels', () => {
    expect(agentDisplayName('omp')).toBe('Oh My Pi');
    expect(agentShortName('omp')).toBe('OMP');
    expect(agentInstallUrl('omp')).toBe('https://github.com/can1357/oh-my-pi');
  });
});
