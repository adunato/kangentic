import fs from 'node:fs';
import path from 'node:path';

export interface CodexStructuredLaunch {
  executable: string;
  argv: string[];
}

interface ResolvedCodexShim {
  executable: string;
  entrypoint: string;
}

/**
 * Resolve the command that an npm-generated Windows Codex shim would invoke.
 *
 * Executing the .CMD file through a PTY sends the prompt through cmd.exe's
 * `%*` expansion. That is not argv-preserving: cmd expands percent variables
 * and treats shell metacharacters specially. Reading the shim lets us invoke
 * node.exe and the Codex JavaScript entrypoint directly instead.
 */
export function resolveCodexCmdShim(
  codexPath: string,
  shimContents: string,
  platform: NodeJS.Platform = process.platform,
  fileExists: (filePath: string) => boolean = fs.existsSync,
): ResolvedCodexShim {
  if (platform !== 'win32' || !/\.cmd$/i.test(codexPath)) {
    return { executable: codexPath, entrypoint: '' };
  }

  const shimDir = path.win32.dirname(codexPath);
  const nvmInvocation = parseNvmWrapperInvocation(shimContents, shimDir, fileExists);
  if (nvmInvocation) return nvmInvocation;

  // npm shims use either `node "%~dp0...js" %*` or a quoted local
  // `"%dp0%\\node.exe" "%dp0%\\...js" %*` branch. Keep the parser narrow:
  // only accept the executable + JS entrypoint pair that is actually followed
  // by the shim's argument forwarding token.
  const invocation = /(?:^|\r?\n)\s*(?:call\s+)?(?:"([^"]+)"|([^\s"]+))\s+(?:"([^"]+\.js)"|([^\s"]+\.js))\s+%\*/gim;
  let match: RegExpExecArray | null;
  while ((match = invocation.exec(shimContents)) !== null) {
    const executableToken = match[1] ?? match[2];
    const entrypointToken = match[3] ?? match[4];
    if (!executableToken || !entrypointToken) continue;

    const executable = resolveShimToken(executableToken, shimDir);
    const entrypoint = resolveShimToken(entrypointToken, shimDir);
    return {
      executable: isBareNodeExecutable(executable) ? 'node.exe' : executable,
      entrypoint,
    };
  }

  throw new Error(`Unable to resolve Codex entrypoint from Windows shim: ${codexPath}`);
}

/**
 * NVM for Windows' wrapper stores the selected runtime in `%_prog%`, then
 * expands it after `endLocal` on a command-operator chain. It is intentionally
 * parsed as a separate, narrow form rather than broadening the generic
 * line-start parser to arbitrary batch syntax.
 */
function parseNvmWrapperInvocation(
  shimContents: string,
  shimDir: string,
  fileExists: (filePath: string) => boolean,
): ResolvedCodexShim | null {
  const hasLocalNodeAssignment = /set\s+["']?_prog\s*=\s*["']?%~?dp0%?[\\/]node\.exe["']?/i.test(shimContents);
  const hasPathNodeAssignment = /set\s+["']?_prog\s*=\s*["']?node["']?/i.test(shimContents);
  if (!hasLocalNodeAssignment || !hasPathNodeAssignment) return null;

  const invocation = /endlocal\b[^\r\n]*?["']?%_prog%["']?\s+(?:"([^"]+\.js)"|([^\s&]+\.js))\s+%\*/i.exec(shimContents);
  if (!invocation) return null;

  const entrypointToken = invocation[1] ?? invocation[2];
  if (!entrypointToken) return null;

  const localNode = resolveShimToken('%dp0%\\node.exe', shimDir);
  return {
    executable: fileExists(localNode) ? localNode : 'node',
    entrypoint: resolveShimToken(entrypointToken, shimDir),
  };
}

/** Resolve a detected Codex path into a direct node.exe launch. */
export function resolveCodexLaunch(
  codexPath: string,
  platform: NodeJS.Platform = process.platform,
  readFile: (filePath: string) => string = (filePath) => fs.readFileSync(filePath, 'utf8'),
): ResolvedCodexShim {
  if (platform !== 'win32' || !/\.cmd$/i.test(codexPath)) {
    return { executable: codexPath, entrypoint: '' };
  }
  return resolveCodexCmdShim(codexPath, readFile(codexPath), platform);
}

function resolveShimToken(token: string, shimDir: string): string {
  const expanded = token
    .replace(/%~dp0/gi, `${shimDir}\\`)
    .replace(/%dp0%/gi, `${shimDir}\\`)
    .replace(/^node(?:\.exe)?$/i, 'node.exe');

  if (expanded === 'node.exe') return expanded;
  return path.win32.normalize(path.win32.isAbsolute(expanded)
    ? expanded
    : path.win32.resolve(shimDir, expanded));
}

function isBareNodeExecutable(executable: string): boolean {
  return /^node(?:\.exe)?$/i.test(executable);
}
