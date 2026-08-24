import type { TranscriptBlock, TranscriptEntry, TranscriptTurnUsage } from '../../../../shared/types';
import { readJsonlWindow } from '../../shared/history-scan';
import { parseWindowBytes, prependTruncationMarker } from '../../shared/transcript-truncation';
import { locateOmpSessionFile, ompSessionDirectory } from './session-history-parser';

/** Parse OMP's v3 append-only JSONL into Kangentic transcript entries. */
export async function parseOmpTranscript(filePath: string): Promise<TranscriptEntry[]> {
  const window = await readJsonlWindow(filePath, { maxBytes: parseWindowBytes() });
  if (window.totalBytes === 0) return [];
  return prependTruncationMarker(
    parseOmpTranscriptContent(window.text),
    window.omittedBytes,
    window.totalBytes,
  );
}

export function parseOmpTranscriptContent(content: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  let entryIndex = 0;

  for (const line of content.split(/\r?\n/)) {
    const record = parseLine(line);
    if (!record) continue;
    const timestamp = parseTimestamp(record.timestamp);
    const uuid = typeof record.id === 'string' && record.id.length > 0
      ? record.id
      : `omp-${entryIndex++}`;

    if (record.type === 'tool_result') {
      const content = collectText(record.content).trim();
      entries.push({
        kind: 'tool_result',
        uuid,
        ts: timestamp,
        toolUseId: firstString(record.toolCallId, record.tool_call_id, record.id) ?? '',
        content,
        isError: record.isError === true || record.is_error === true,
      });
      continue;
    }
    if (record.type === 'message') {
      const message = isObject(record.message) ? record.message : null;
      if (!message || typeof message.role !== 'string') continue;
      const role = message.role;
      const contentValue = message.content;
      if (role === 'user') {
        const text = collectText(contentValue).trim();
        if (text) entries.push({ kind: 'user', uuid, ts: timestamp, text });
        continue;
      }
      if (role === 'assistant') {
        const blocks = collectAssistantBlocks(contentValue);
        if (blocks.length === 0) continue;
        const model = typeof message.model === 'string' ? message.model : undefined;
        const usage = parseTurnUsage(message.usage);
        entries.push({ kind: 'assistant', uuid, ts: timestamp, model, usage, blocks });
        continue;
      }
      if (role === 'toolResult' || role === 'tool_result' || role === 'tool') {
        const content = collectText(contentValue).trim();
        const toolUseId = firstString(message.toolCallId, message.tool_call_id, message.id) ?? '';
        entries.push({
          kind: 'tool_result',
          uuid,
          ts: timestamp,
          toolUseId,
          content,
          isError: message.isError === true || message.is_error === true,
        });
        continue;
      }
      if (role === 'system') {
        const text = collectText(contentValue).trim();
        if (text) entries.push({ kind: 'system', uuid, ts: timestamp, subtype: 'command', text });
        continue;
      }
      continue;
    }

    const system = parseMeaningfulSystemRecord(record, uuid, timestamp);
    if (system) entries.push(system);
  }
  return entries;
}
export async function parseOmpTranscriptWindow(
  filePath: string,
  startByte: number,
  maxBytes: number,
): Promise<{
  entries: TranscriptEntry[];
  nextByteOffset: number;
  totalBytes: number;
}> {
  const window = await readJsonlWindow(filePath, { startByte, maxBytes });
  return {
    entries: parseOmpTranscriptContent(window.text),
    nextByteOffset: window.nextByteOffset,
    totalBytes: window.totalBytes,
  };
}

/** Resolve a known OMP session file for generic transcript callers. */
export async function locateOmpTranscriptFile(agentSessionId: string, cwd: string): Promise<string | null> {
  return locateOmpSessionFile(agentSessionId, cwd);
}

// Kept as a small exported seam for callers that need to display the native
// bucket without performing a file lookup.
export function ompTranscriptDirectory(cwd: string): string {
  return ompSessionDirectory(cwd);
}

function parseMeaningfulSystemRecord(
  record: Record<string, unknown>,
  uuid: string,
  ts: number,
): TranscriptEntry | null {
  const type = typeof record.type === 'string' ? record.type : '';
  if (type === 'session') {
    // The v3 header is metadata, not a conversation turn.
    return null;
  }
  if (type === 'title') {
    return null;
  }
  if (type === 'compaction') {
    const summary = firstString(record.summary, record.shortSummary);
    return summary ? { kind: 'system', uuid, ts, subtype: 'compaction', text: summary } : null;
  }
  if (type === 'reset_boundary') {
    return { kind: 'system', uuid, ts, subtype: 'session_boundary', text: 'Session context reset.' };
  }
  if (type === 'branch_summary') {
    const summary = firstString(record.summary);
    return summary ? { kind: 'system', uuid, ts, subtype: 'compaction', text: summary } : null;
  }
  if (type === 'title_change') {
    const title = firstString(record.title);
    return title ? { kind: 'system', uuid, ts, subtype: 'command', text: `Session title changed to: ${title}` } : null;
  }
  if (type === 'model_change') {
    const model = firstString(record.model);
    return model ? { kind: 'system', uuid, ts, subtype: 'command', text: `Model changed to ${model}.` } : null;
  }
  if (type === 'thinking_level_change') {
    const level = firstString(record.configured, record.thinkingLevel);
    return level ? { kind: 'system', uuid, ts, subtype: 'command', text: `Thinking level changed to ${level}.` } : null;
  }
  if (type === 'mode_change') {
    const mode = firstString(record.mode);
    return mode ? { kind: 'system', uuid, ts, subtype: 'command', text: `Mode changed to ${mode}.` } : null;
  }
  if (type === 'session_init') {
    const task = firstString(record.task);
    return task ? { kind: 'system', uuid, ts, subtype: 'session_boundary', text: `Session initialized: ${task}` } : null;
  }
  if (type === 'custom_message' && record.display !== false) {
    const text = collectText(record.content).trim();
    return text ? { kind: 'user', uuid, ts, text } : null;
  }
  return null;
}

function collectAssistantBlocks(value: unknown): TranscriptBlock[] {
  if (typeof value === 'string') return value.trim() ? [{ type: 'text', text: value }] : [];
  if (!Array.isArray(value)) return [];
  const blocks: TranscriptBlock[] = [];
  for (const item of value) {
    if (!isObject(item)) continue;
    const tool = isObject(item.toolCall)
      ? item.toolCall
      : isObject(item.tool_call)
        ? item.tool_call
        : isObject(item.functionCall)
          ? item.functionCall
          : item.type === 'toolCall' || item.type === 'tool_call'
            ? item
            : null;
    if (tool) {
      blocks.push({
        type: 'tool_use',
        id: firstString(tool.id, tool.toolCallId) ?? '',
        name: firstString(tool.name, tool.function) ?? 'tool',
        input: tool.arguments ?? tool.args ?? tool.input ?? {},
      });
      continue;
    }
    const thinking = item.type === 'thinking' || item.thought === true;
    const text = firstString(item.text, item.thinking, item.content);
    if (!text || !text.trim()) continue;
    blocks.push({ type: thinking ? 'thinking' : 'text', text });
  }
  return blocks;
}

function collectText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) {
    if (isObject(value)) {
      const direct = firstString(value.text, value.output, value.result);
      if (direct) return direct;
      if (value.content !== undefined) return collectText(value.content);
      try {
        return JSON.stringify(value);
      } catch {
        return '';
      }
    }
    return '';
  }
  return value.map((item) => {
    if (typeof item === 'string') return item;
    if (!isObject(item)) return '';
    const text = firstString(item.text, item.output, item.result);
    return text ?? (item.content !== undefined ? collectText(item.content) : '');
  }).filter(Boolean).join('');
}

function parseTurnUsage(value: unknown): TranscriptTurnUsage | undefined {
  if (!isObject(value)) return undefined;
  const inputTokens = numberFrom(value, 'inputTokens', 'input', 'promptTokens');
  const outputTokens = numberFrom(value, 'outputTokens', 'output', 'completionTokens');
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return {
    inputTokens: inputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    cacheCreationInputTokens: numberFrom(value, 'cacheWriteTokens', 'cacheCreationInputTokens') ?? 0,
    cacheReadInputTokens: numberFrom(value, 'cacheReadTokens', 'cacheReadInputTokens') ?? 0,
  };
}

function parseLine(line: string): Record<string, unknown> | null {
  const trimmed = line.replace(/\0/g, '').trim();
  if (!trimmed) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    return isObject(value) ? value : null;
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      const value: unknown = JSON.parse(trimmed.slice(start, end + 1));
      return isObject(value) ? value : null;
    } catch {
      return null;
    }
  }
}

function parseTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function numberFrom(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
