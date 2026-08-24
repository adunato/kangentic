import type * as NodeOs from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testHome = vi.hoisted(() => `${process.env.TEMP ?? process.env.TMP ?? '/tmp'}/omp-history-test-home-${process.pid}`);
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<NodeOs>();
  return {
    ...actual,
    homedir: () => testHome,
    default: { ...actual.default, homedir: () => testHome },
  };
});

import { Activity, EventType } from '../../src/shared/types';
import {
  assertOmpResumeSession,
  captureOmpSessionFromFilesystem,
  ompSessionDirectory,
  parseOmpHeader,
  parseOmpSessionHistory,
} from '../../src/main/agent/adapters/omp/session-history-parser';

const fixturePath = path.join(process.cwd(), 'tests', 'fixtures', 'omp-v3-session.jsonl');
const fixture = fs.readFileSync(fixturePath, 'utf8');

beforeEach(() => {
  fs.rmSync(testHome, { recursive: true, force: true });
  fs.mkdirSync(testHome, { recursive: true });
});

afterEach(() => {
  fs.rmSync(testHome, { recursive: true, force: true });
});

describe('OMP v3 session header', () => {
  it('accepts the physical 256-byte title slot before the v3 header', () => {
    const firstLineBytes = Buffer.byteLength(fixture.slice(0, fixture.indexOf('\n') + 1));
    expect(firstLineBytes).toBe(256);

    const header = parseOmpHeader(fixture);
    expect(header).toEqual({
      type: 'session',
      version: 3,
      id: 'omp-fixture-session-1804',
      cwd: '/fixture/project',
      timestamp: '2026-08-24T12:00:01.000Z',
      title: 'Fixture session',
    });
  });

  it('ignores malformed and non-v3 records while finding a valid header', () => {
    expect(parseOmpHeader('not-json\n{"type":"session","version":2,"id":"old","cwd":"/x"}\n')).toBeNull();
    expect(parseOmpHeader('\0  {"type":"session","version":3,"id":"ok","cwd":"/x"}  \n')).toEqual({
      type: 'session', version: 3, id: 'ok', cwd: '/x',
    });
  });

  it('maps OMP messages to usage, tool lifecycle, and final activity', () => {
    const result = parseOmpSessionHistory(fixture, 'full');

    expect(result.usage).toMatchObject({
      contextWindow: {
        usedTokens: 120,
        totalInputTokens: 120,
        totalOutputTokens: 24,
        cacheTokens: 15,
        contextWindowSize: 120,
      },
      model: { id: 'anthropic/claude-sonnet-4-6' },
    });
    expect(result.events).toEqual([
      { ts: Date.parse('2026-08-24T12:00:03.000Z'), type: EventType.ToolStart, tool: 'read', toolId: 'tool-1', detail: 'read' },
      { ts: Date.parse('2026-08-24T12:00:04.000Z'), type: EventType.ToolEnd, tool: 'tool', toolId: 'tool-1' },
    ]);
    expect(result.activity).toBe(Activity.Idle);
  });

  it('ignores malformed lines and records with unknown roles', () => {
    const content = [
      'broken',
      JSON.stringify({ type: 'session', version: 3, id: 's', cwd: '/x' }),
      JSON.stringify({ type: 'message', message: { role: 'system', content: 'skip' } }),
      JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ tool_call: { name: 'shell' } }] } }),
    ].join('\n');

    const result = parseOmpSessionHistory(content, 'append');
    expect(result.usage).toBeNull();
    expect(result.events).toEqual([
      { ts: expect.any(Number), type: EventType.ToolStart, tool: 'shell', toolId: undefined, detail: 'shell' },
    ]);
  });
});

describe('OMP session discovery and resume safety', () => {
  function writeSession(cwd: string, id: string, content = fixture): string {
    const directory = ompSessionDirectory(cwd);
    fs.mkdirSync(directory, { recursive: true });
    const filePath = path.join(directory, `session_${id}.jsonl`);
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  it('captures the sole newly-created v3 session for the exact cwd', async () => {
    const cwd = path.join(testHome, 'projects', 'capture');
    const root = path.join(testHome, 'capture-root');
    const launchStartedAt = new Date(Date.now() - 50);
    const sessionId = 'captured-session';
    const header = JSON.stringify({
      type: 'session', version: 3, id: sessionId,
      timestamp: new Date().toISOString(), cwd,
    });
    const directory = ompSessionDirectory(cwd, root);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `session_${sessionId}.jsonl`), `${fixture.slice(0, fixture.indexOf('\n') + 1)}${header}\n`);

    await expect(captureOmpSessionFromFilesystem({
      spawnedAt: new Date(), launchStartedAt, cwd, rolloutRoot: root,
      timeoutMs: 1, maxAttempts: 1,
    })).resolves.toBe(sessionId);
  });

  it('fails closed when two matching sessions appear', async () => {
    const cwd = path.join(testHome, 'projects', 'ambiguous');
    const root = path.join(testHome, 'capture-root');
    const launchStartedAt = new Date(Date.now() - 50);
    const directory = ompSessionDirectory(cwd, root);
    fs.mkdirSync(directory, { recursive: true });
    for (const id of ['one', 'two']) {
      const header = JSON.stringify({ type: 'session', version: 3, id, timestamp: new Date().toISOString(), cwd });
      fs.writeFileSync(path.join(directory, `session_${id}.jsonl`), `${header}\n`);
    }

    await expect(captureOmpSessionFromFilesystem({
      spawnedAt: new Date(), launchStartedAt, cwd, rolloutRoot: root,
      timeoutMs: 1, maxAttempts: 1,
    })).resolves.toBeNull();
  });

  it('allows resume only for a session whose header cwd matches', () => {
    const cwd = path.join(testHome, 'projects', 'resume');
    const encodedCwd = JSON.stringify(cwd).slice(1, -1);
    writeSession(cwd, 'resume-ok', fixture.replace('/fixture/project', encodedCwd).replace('omp-fixture-session-1804', 'resume-ok'));

    expect(() => assertOmpResumeSession('resume-ok', cwd)).not.toThrow();
    expect(() => assertOmpResumeSession('resume-ok', path.join(testHome, 'other'))).toThrow(/resume refused/);
    expect(() => assertOmpResumeSession('missing', cwd)).toThrow(/not found/);
  });

  it('does not resume a malformed file even when its filename contains the id', () => {
    const cwd = path.join(testHome, 'projects', 'malformed');
    writeSession(cwd, 'malformed', 'not-json\n');

    expect(() => assertOmpResumeSession('malformed', cwd)).toThrow(/not found/);
  });
});
