import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Locate a Pi session JSONL file for a caller-owned session id.
 *
 * Pi's default layout is:
 *   <agentDir>/sessions/--<resolved-cwd>--/<timestamp>_<session-id>.jsonl
 *
 * The CLI also supports a custom session directory through
 * PI_CODING_AGENT_SESSION_DIR. We deliberately do not parse the transcript
 * here: Pi's JSONL tree is not a safe one-to-one mapping to Kangentic's
 * TranscriptEntry contract yet, but the native path is still useful for
 * handoff metadata and resume reconciliation.
 */
export async function locatePiSessionHistoryFile(
  agentSessionId: string,
  cwd: string,
): Promise<string | null> {
  const sessionRoots = getSessionRoots(cwd);
  const encodedDirectories = getEncodedCwdDirectories(cwd);

  for (const root of sessionRoots) {
    // A custom --session-dir / PI_CODING_AGENT_SESSION_DIR is allowed to point
    // directly at files, so check the root before the default cwd directory.
    const directMatch = findSessionFile(root, agentSessionId);
    if (directMatch) return directMatch;

    for (const encodedDirectory of encodedDirectories) {
      const match = findSessionFile(path.join(root, encodedDirectory), agentSessionId);
      if (match) return match;
    }

    // Older Pi builds and user-customized layouts may encode the cwd
    // differently. Scan only the immediate child directories, and only for a
    // filename containing the exact session id, to stay bounded and avoid
    // reading arbitrary project files.
    const fallbackMatch = scanChildDirectories(root, agentSessionId);
    if (fallbackMatch) return fallbackMatch;
  }

  return null;
}

function getSessionRoots(cwd: string): string[] {
  const configuredSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
  if (configuredSessionDir) {
    return [resolveConfiguredPath(configuredSessionDir, cwd)];
  }

  const configuredAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = configuredAgentDir
    ? resolveConfiguredPath(configuredAgentDir, cwd)
    : path.join(os.homedir(), '.pi', 'agent');
  return [path.join(agentDir, 'sessions')];
}

function resolveConfiguredPath(value: string, cwd: string): string {
  const expanded = value.replace(/^~(?=$|[\\/])/, os.homedir());
  return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
}

function getEncodedCwdDirectories(cwd: string): string[] {
  const resolvedCwd = path.resolve(cwd);
  // This is Pi's current encoding (see coding-agent/core/session-manager.ts).
  const current = `--${resolvedCwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;

  // Keep the older wrapped and unwrapped spellings as cheap compatibility
  // candidates. The fallback child-directory scan handles other historical
  // encodings without needing to guess them here.
  const unwrapped = resolvedCwd.replace(/[/\\:]/g, '-');
  return Array.from(new Set([current, `--${unwrapped}--`, unwrapped]));
}

function findSessionFile(directory: string, sessionId: string): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    if (!isSessionFileName(entry.name, sessionId)) continue;
    return path.join(directory, entry.name);
  }
  return null;
}

function scanChildDirectories(root: string, sessionId: string): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = findSessionFile(path.join(root, entry.name), sessionId);
    if (match) return match;
  }
  return null;
}

function isSessionFileName(fileName: string, sessionId: string): boolean {
  if (!fileName.endsWith('.jsonl')) return false;
  const stem = fileName.slice(0, -'.jsonl'.length);
  return stem === sessionId
    || stem.endsWith(`_${sessionId}`)
    || stem.endsWith(`-${sessionId}`);
}
