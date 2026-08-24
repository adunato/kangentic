import { AgentDetector } from '../../shared/agent-detector';
import { standardUnixFallbackPaths } from '../../shared/fallback-paths';

/** Detect the Oh My Pi CLI without relying on a package-manager layout. */
export class OmpDetector extends AgentDetector {
  constructor() {
    super({
      binaryName: 'omp',
      fallbackPaths: standardUnixFallbackPaths('omp'),
      parseVersion: (raw) => {
        const match = raw.match(/(?:^|\s)v?(\d+\.\d+(?:\.\d+)*(?:[-+][\w.-]+)?)(?:\s|$)/i);
        return match?.[1] ?? null;
      },
    });
  }
}
