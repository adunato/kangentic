import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalHeaderHash, canonicalNativePath, sourceEvidence } from '../../src/main/execution-history/native-slice-ownership';

describe('native slice ownership evidence', () => {
  it('canonicalizes header object key order without changing scalar types', () => {
    expect(canonicalHeaderHash('{"b":2,"a":1}')).toBe(canonicalHeaderHash('{"a":1,"b":2}'));
    expect(canonicalHeaderHash('{"a":"1"}')).not.toBe(canonicalHeaderHash('{"a":1}'));
  });
  it('records bounded prefix evidence and optional filesystem identity', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-history-'));
    const file = path.join(dir, 'session.jsonl');
    fs.writeFileSync(file, '{"type":"session","version":3,"id":"n","cwd":"/tmp"}\n{"type":"message"}\n');
    const evidence = sourceEvidence(file, 'n');
    expect(evidence?.nativeSessionId).toBe('n');
    expect(evidence?.prefixHash).toMatch(/^[a-f0-9]{64}$/);
    expect(canonicalNativePath(file)).not.toContain('\\');
  });

  it('does not turn an unavailable source into a canonical fallback path', () => {
    expect(() => canonicalNativePath(path.join(os.tmpdir(), 'missing-kangentic-source.jsonl'))).toThrow();
    expect(sourceEvidence(path.join(os.tmpdir(), 'missing-kangentic-source.jsonl'), 'missing')).toBeNull();
  });
});
