import { useEffect, useState, type ChangeEvent } from 'react';
import type { ExecutionHistoryDetail, ExecutionHistoryFilter, ExecutionHistoryResponse, ExecutionSliceTranscriptResponse } from '../../../../shared/types';

interface Props { projectId: string; taskId: string; className?: string }

/** Database-first execution history surface. Native transcript loading is explicit per row. */
export function ExecutionHistoryPanel({ projectId, taskId, className = '' }: Props) {
  const [response, setResponse] = useState<ExecutionHistoryResponse | null>(null);
  const [filter, setFilter] = useState<ExecutionHistoryFilter>({});
  const [selected, setSelected] = useState<ExecutionHistoryDetail | null>(null);
  const [transcript, setTranscript] = useState<ExecutionSliceTranscriptResponse | null>(null);
  const [loadingTranscript, setLoadingTranscript] = useState(false);
  useEffect(() => { let alive = true; void window.electronAPI.executionHistory.get({ projectId, taskId, filter }).then((value) => { if (alive) setResponse(value); }); return () => { alive = false; }; }, [projectId, taskId, filter]);
  const loadTranscript = async () => { if (!selected) return; setLoadingTranscript(true); try { setTranscript(await window.electronAPI.executionHistory.getSliceTranscript({ projectId, sessionId: selected.sessionId })); } finally { setLoadingTranscript(false); } };
  if (!response) return <div className={`p-4 text-fg-muted ${className}`} data-testid="execution-history-loading">Loading execution history…</div>;
  return <section className={`flex min-h-0 flex-col gap-3 overflow-auto p-3 ${className}`} data-testid="execution-history-panel">
    <div className="flex flex-wrap items-center gap-2">
      <h3 className="font-semibold">History</h3>
      <select aria-label="Execution result filter" value={filter.executionResult ?? ''} onChange={(event: ChangeEvent<HTMLSelectElement>) => setFilter({ ...filter, executionResult: event.target.value ? event.target.value as ExecutionHistoryFilter['executionResult'] : undefined })}>
        <option value="">All results</option><option value="succeeded">Succeeded</option><option value="failed">Failed</option><option value="suspended">Suspended</option><option value="interrupted">Interrupted</option>
      </select>
      <select aria-label="Telemetry status filter" value={filter.telemetryStatus ?? ''} onChange={(event: ChangeEvent<HTMLSelectElement>) => setFilter({ ...filter, telemetryStatus: event.target.value ? event.target.value as ExecutionHistoryFilter['telemetryStatus'] : undefined })}>
        <option value="">All telemetry</option><option value="complete">Complete</option><option value="partial">Partial</option><option value="unavailable">Unavailable</option>
      </select>
    </div>
    {response.items.length === 0 ? <div className="p-4 text-fg-muted" data-testid="execution-history-empty">No execution history yet.</div> : <div className="grid gap-2">{response.items.map((item) => <button key={item.sessionId} type="button" className="rounded border border-edge p-3 text-left hover:bg-surface-hover" onClick={() => { setSelected(item); setTranscript(null); }}><div className="flex justify-between gap-2"><strong>{item.stage.name ?? 'Legacy execution'}</strong><span>{item.executionResult}</span></div><div className="text-xs text-fg-muted">{new Date(item.startedAt).toLocaleString()} · telemetry: {item.telemetryStatus}{item.stage.attempt ? ` · attempt ${item.stage.attempt}` : ''}</div><div className="text-xs">{item.inputTokens ?? '—'} input · {item.outputTokens ?? '—'} output · cost {item.costUsd ?? '—'}</div></button>)}</div>}
    {selected && <div className="rounded border border-edge p-3" data-testid="execution-history-detail"><h4 className="font-semibold">Execution details</h4><p>Result: {selected.executionResult} · Telemetry: {selected.telemetryStatus}</p><p className="text-xs text-fg-muted">Agent {selected.provenance.agentId ?? 'unknown'} · config {selected.provenance.configHash ?? 'unknown'}</p><button type="button" className="mt-2 rounded border border-edge px-2 py-1" disabled={loadingTranscript} onClick={() => void loadTranscript()}>{loadingTranscript ? 'Loading transcript…' : 'Load selected transcript'}</button>{transcript && ('entries' in transcript ? <div className="mt-2 text-xs" data-testid="execution-slice-transcript">{transcript.entries.length} bounded entries loaded ({transcript.state})</div> : <div className="mt-2 text-xs text-fg-muted" data-testid="execution-slice-unavailable">{transcript.message}</div>)}</div>}
  </section>;
}
