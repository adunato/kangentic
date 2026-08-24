import os from 'node:os';
import path from 'node:path';
import { AgentDetector } from '../../shared/agent-detector';
import { standardUnixFallbackPaths } from '../../shared/fallback-paths';

/** Detect the Oh My Pi CLI without relying on a package-manager layout. */
export class OmpDetector extends AgentDetector {
  constructor() {
    super({
      binaryName: 'omp',
      fallbackPaths: [
        ...standardUnixFallbackPaths('omp'),
        ...(process.platform === 'win32'
          ? [path.join(os.homedir(), '.bun', 'bin', 'omp.exe')]
          : []),
      ],
      parseVersion: (raw) => {
        const match = raw.match(/(?:^|\s)(?:omp[/\s])?v?(\d+\.\d+(?:\.\d+)*(?:[-+][\w.-]+)?)(?:\s|$)/i);
        return match?.[1] ?? null;
      },
    });
  }
}
