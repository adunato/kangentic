import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseOmpTranscript,
  parseOmpTranscriptContent,
  parseOmpTranscriptWindow,
} from '../../src/main/agent/adapters/omp/transcript-parser';
import { setParseWindowBytesForTests } from '../../src/main/agent/shared/transcript-truncation';

const fixturePath = path.join(process.cwd(), 'tests', 'fixtures', 'omp-v3-session.jsonl');
const fixture = fs.readFileSync(fixturePath, 'utf8');
const temporaryDirectories: string[] = [];

function writeFile(content: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-transcript-'));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, 'session_omp.jsonl');
  fs.writeFileSync(filePath, content);
  return filePath;
}

afterEach(() => {
  setParseWindowBytesForTests();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('parseOmpTranscriptContent', () => {
  it('maps the v3 fixture into user, assistant, tool-result, and system entries', () => {
    const entries = parseOmpTranscriptContent(fixture);

    expect(entries).toHaveLength(8);
    expect(entries[0]).toMatchObject({
      kind: 'user', uuid: 'omp-user-1', text: 'Inspect the fixture',
    });
    expect(entries[1]).toMatchObject({
      kind: 'assistant', uuid: 'omp-assistant-1', model: 'anthropic/claude-sonnet-4-6',
      blocks: [
        { type: 'thinking', text: 'I will inspect it.' },
        { type: 'text', text: 'The fixture is healthy.' },
        { type: 'tool_use', id: 'tool-1', name: 'read', input: { path: 'README.md' } },
      ],
      usage: {
        inputTokens: 120, outputTokens: 24,
        cacheCreationInputTokens: 5, cacheReadInputTokens: 10,
      },
    });
    expect(entries[2]).toMatchObject({
      kind: 'tool_result', uuid: 'omp-tool-1', toolUseId: 'tool-1', content: 'contents', isError: false,
    });
    expect(entries.slice(3)).toEqual([
      expect.objectContaining({ kind: 'system', subtype: 'compaction', text: 'Earlier context compacted' }),
      expect.objectContaining({ kind: 'system', subtype: 'command', text: 'Session title changed to: Fixture complete' }),
      expect.objectContaining({ kind: 'system', subtype: 'command', text: 'Thinking level changed to high.' }),
      expect.objectContaining({ kind: 'system', subtype: 'session_boundary', text: 'Session context reset.' }),
      expect.objectContaining({ kind: 'system', subtype: 'command', text: 'Model changed to anthropic/claude-sonnet-4-6.' }),
    ]).toHaveLength(5);
  });

  it('skips title slots, headers, malformed lines, and unknown records', () => {
    const entries = parseOmpTranscriptContent([
      '{"type":"title","v":1,"title":"","pad":""}',
      '{"type":"session","version":3,"id":"s","cwd":"/x"}',
      'prefix {"type":"message","id":"u","message":{"role":"user","content":"safe"}} suffix',
      'not-json',
      JSON.stringify({ type: 'unknown', id: 'unknown' }),
    ].join('\n'));

    expect(entries).toEqual([{ kind: 'user', uuid: 'u', ts: expect.any(Number), text: 'safe' }]);
  });

  it('supports nested text/tool aliases and tool errors', () => {
    const entries = parseOmpTranscriptContent(JSON.stringify({
      type: 'message', id: 'a', timestamp: 123, message: {
        role: 'assistant', content: [
          { thought: true, content: 'private thought' },
          { functionCall: { id: 'fn-1', function: 'shell', args: { command: 'pwd' } } },
        ],
      },
    }) + '\n' + JSON.stringify({
      type: 'message', id: 'r', timestamp: 124, message: {
        role: 'tool_result', tool_call_id: 'fn-1', content: [{ text: 'failed' }], is_error: true,
      },
    }));

    expect(entries).toMatchObject([
      { kind: 'assistant', blocks: [
        { type: 'thinking', text: 'private thought' },
        { type: 'tool_use', id: 'fn-1', name: 'shell', input: { command: 'pwd' } },
      ] },
      { kind: 'tool_result', toolUseId: 'fn-1', content: 'failed', isError: true },
    ]);
  });
});

describe('bounded OMP transcript parsing', () => {
  it('returns an omission marker when the transcript exceeds the parse cap', async () => {
    const content = [
      ...Array.from({ length: 10 }, (_, index) => JSON.stringify({
        type: 'message', id: `old-${index}`, message: { role: 'user', content: `old ${index}` },
      })),
      JSON.stringify({ type: 'message', id: 'new', message: { role: 'user', content: 'newest' } }),
    ].join('\n') + '\n';
    const filePath = writeFile(content);
    setParseWindowBytesForTests(180);

    const entries = await parseOmpTranscript(filePath);

    expect(entries[0]).toMatchObject({ kind: 'system', subtype: 'truncated' });
    expect(entries.some((entry) => entry.kind === 'user' && entry.text === 'newest')).toBe(true);
    expect(entries.some((entry) => entry.kind === 'user' && entry.text === 'old 0')).toBe(false);
  });

  it('parses a JSONL window from a byte offset and reports progress', async () => {
    const filePath = writeFile([
      JSON.stringify({ type: 'message', id: 'one', message: { role: 'user', content: 'one' } }),
      JSON.stringify({ type: 'message', id: 'two', message: { role: 'user', content: 'two' } }),
    ].join('\n') + '\n');

    const first = await parseOmpTranscriptWindow(filePath, 0, 90);
    expect(first.totalBytes).toBeGreaterThan(90);
    expect(first.nextByteOffset).toBeGreaterThan(0);
    expect(first.entries.length).toBeGreaterThan(0);

    const second = await parseOmpTranscriptWindow(filePath, first.nextByteOffset, 90);
    expect(second.nextByteOffset).toBe(first.totalBytes);
    expect(second.entries).toEqual([
      expect.objectContaining({ kind: 'user', text: 'two' }),
    ]);
  });

  it('returns an empty transcript for a missing file', async () => {
    await expect(parseOmpTranscript(path.join(os.tmpdir(), 'omp-no-such-session.jsonl'))).resolves.toEqual([]);
  });
});
