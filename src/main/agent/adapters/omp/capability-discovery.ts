import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentCapabilities } from '../../../../shared/types';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const HELP_TIMEOUT_MS = 5000;

async function readHelpText(cliPath: string): Promise<string> {
  if (process.platform === 'win32') {
    const result = await execAsync(`"${cliPath}" --help`, {
      timeout: HELP_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return `${result.stdout}\n${result.stderr}`;
  }
  const result = await execFileAsync(cliPath, ['--help'], {
    timeout: HELP_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  return `${result.stdout}\n${result.stderr}`;
}

/** Discover only controls that this installed OMP binary advertises. */
export async function discoverOmpCapabilities(cliPath: string): Promise<AgentCapabilities> {
  try {
    const help = await readHelpText(cliPath);
    const supportsModelOverride = /(?:^|\s)(?:-m,?\s*)?--model(?:[=\s]|$)/m.test(help);
    const thinkingMatch = help.match(/(?:^|\s)--thinking(?:[=\s][^\r\n]*)?/m);
    if (!thinkingMatch) return { supportsModelOverride };

    const effortLevels = discoverThinkingChoices(thinkingMatch[0]);
    return {
      supportsModelOverride,
      effortLevels,
    };
  } catch {
    return {};
  }
}

function discoverThinkingChoices(optionText: string): string[] {
  const bracketed = optionText.match(/[[{(<]([^\]})>]+)[\]})>]/)?.[1];
  if (!bracketed) return [];
  const choices = bracketed
    .split(/[|,]/)
    .map((choice) => choice.trim())
    .filter((choice) => /^[a-z][a-z0-9_-]*$/i.test(choice));
  return Array.from(new Set(choices));
}
