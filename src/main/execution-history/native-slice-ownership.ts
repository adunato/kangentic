import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SourceEvidence } from '../db/repositories/execution-history-repository';

export function canonicalNativePath(filePath: string): string {
  // Native source paths are identity metadata. Never silently accept an
  // unresolved path: a missing/renamed source must be reported as unavailable
  // by the caller rather than becoming a new lineage.
  let resolved = fs.realpathSync.native(filePath);
  resolved = path.resolve(resolved).replace(/\\/g, '/');
  return /^[A-Za-z]:/.test(resolved) ? resolved[0].toLowerCase() + resolved.slice(1) : resolved;
}
export function sha256(data: Buffer | string): string { return crypto.createHash('sha256').update(data).digest('hex'); }
function recursivelySort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(recursivelySort);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, recursivelySort(child)]),
  );
}
export function canonicalHeaderHash(headerLine: string): string | null {
  try {
    // JSON.stringify is deliberately compact and preserves scalar types.
    return sha256(JSON.stringify(recursivelySort(JSON.parse(headerLine))));
  } catch {
    return null;
  }
}
function firstCompleteHeader(content: string): string | null {
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (value && value.type === 'session') return line;
    } catch {
      // A partial final line is not a complete header; continue searching.
    }
  }
  return null;
}
function hashPrefix(fd: number, size: number): string {
  const length = Math.min(64 * 1024, size);
  const prefix = Buffer.alloc(length);
  const read = length === 0 ? 0 : fs.readSync(fd, prefix, 0, length, 0);
  return sha256(prefix.subarray(0, read));
}
export function sourceEvidence(filePath: string, nativeSessionId: string): SourceEvidence | null {
  let canonicalPath: string;
  let stat: fs.Stats;
  let fd: number;
  try {
    canonicalPath = canonicalNativePath(filePath);
    stat = fs.statSync(filePath);
    fd = fs.openSync(filePath, 'r');
  } catch {
    return null;
  }
  try {
    const prefixHash = hashPrefix(fd, stat.size);
    const headerBuffer = Buffer.alloc(Math.min(stat.size, 128 * 1024));
    const bytes = headerBuffer.length === 0 ? 0 : fs.readSync(fd, headerBuffer, 0, headerBuffer.length, 0);
    const headerLine = firstCompleteHeader(headerBuffer.toString('utf8', 0, bytes));
    const canonicalHeader = headerLine ? canonicalHeaderHash(headerLine) : null;
    if (!canonicalHeader) return null;
    const identity = stat.dev !== undefined && stat.ino !== undefined
      ? `${stat.dev}:${stat.ino}`
      : null;
    return {
      nativeSessionId,
      canonicalPath,
      canonicalHeaderHash: canonicalHeader,
      prefixHash,
      filesystemIdentity: identity,
      observedSize: stat.size,
      durableFrontier: 0,
      durableFrontierOrdinal: 0,
      durableFrontierHash: sha256(Buffer.alloc(0)),
    };
  } finally {
    fs.closeSync(fd);
  }
}
export function hashRange(filePath: string, start: number, end: number): string | null {
  let fd: number; try { fd = fs.openSync(filePath, 'r'); } catch { return null; }
  try {
    const length = Math.max(0, Math.min(end - start, 1024 * 1024));
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(fd, buffer, 0, length, start);
    return sha256(buffer.subarray(0, read));
  } catch { return null; } finally { fs.closeSync(fd); }
}
