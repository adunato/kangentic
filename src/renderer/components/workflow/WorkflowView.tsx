import { useEffect, useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  ChevronRight,
  GitBranch,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import type { Action, ActionConfig, ActionType, Swimlane, SwimlaneTransition } from '../../../shared/types';
import { useBoardStore } from '../../stores/board-store';
import { useProjectStore } from '../../stores/project-store';
import { useWorkflowStore } from '../../stores/workflow-store';

const ANY_COLUMN = '*';
const ACTION_TYPES: ActionType[] = [
  'create_worktree',
  'spawn_agent',
  'send_command',
  'create_pr',
  'run_script',
  'cleanup_worktree',
  'kill_session',
  'webhook',
];

interface WorkflowRoute {
  key: string;
  fromId: string;
  toId: string;
  transitions: SwimlaneTransition[];
}

const routeKey = (fromId: string, toId: string) => `${fromId}::${toId}`;

function parseConfig(value: string): ActionConfig {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as ActionConfig : {};
  } catch {
    return {};
  }
}

function actionTypeLabel(type: ActionType) {
  return type.replaceAll('_', ' ');
}

function columnName(id: string, swimlanes: Swimlane[]) {
  if (id === ANY_COLUMN) return 'Any column';
  return swimlanes.find((lane) => lane.id === id)?.name ?? 'Unknown column';
}

function routeLabel(route: WorkflowRoute, swimlanes: Swimlane[]) {
  return `${columnName(route.fromId, swimlanes)} → ${columnName(route.toId, swimlanes)}`;
}

/** A wildcard source is an incoming route for its concrete destination. */
export function routeInvolvesColumn(route: Pick<WorkflowRoute, 'fromId' | 'toId'>, columnId: string) {
  return route.fromId === columnId
    || route.toId === columnId
    || (route.fromId === ANY_COLUMN && route.toId === columnId);
}

function actionConfigText(action: Action) {
  return JSON.stringify(parseConfig(action.config_json), null, 2);
}

function ActionForm({
  action,
  onCancel,
  onSaved,
}: {
  action: Action | null;
  onCancel: () => void;
  onSaved: (saved: Action) => void;
}) {
  const createAction = useWorkflowStore((state) => state.createAction);
  const updateAction = useWorkflowStore((state) => state.updateAction);
  const [name, setName] = useState(action?.name ?? '');
  const [type, setType] = useState<ActionType>(action?.type ?? 'spawn_agent');
  const [configText, setConfigText] = useState(action ? actionConfigText(action) : '{}');
  const [prompt, setPrompt] = useState(action ? String(parseConfig(action.config_json).promptTemplate ?? '') : '');
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!name.trim()) {
      setError('Action name is required.');
      return;
    }
    let config: ActionConfig;
    try {
      const parsed: unknown = JSON.parse(configText || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Configuration must be a JSON object.');
      config = parsed as ActionConfig;
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Configuration must be valid JSON.');
      return;
    }
    if (type === 'spawn_agent') config.promptTemplate = prompt;
    const serialized = JSON.stringify(config);
    try {
      const saved = action
        ? await updateAction({ id: action.id, name: name.trim(), type, config_json: serialized })
        : await createAction({ name: name.trim(), type, config_json: serialized });
      onSaved(saved);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save action.');
    }
  };

  return (
    <div className="mt-4 rounded-lg border border-edge-input bg-surface-raised p-4" data-testid="workflow-action-editor">
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-semibold text-fg">{action ? 'Edit action' : 'New action'}</div>
        <button type="button" onClick={onCancel} className="p-1 text-fg-muted hover:text-fg" aria-label="Close action editor"><X size={15} /></button>
      </div>
      <label className="block text-xs font-medium text-fg-muted mb-1" htmlFor="workflow-action-name">Name</label>
      <input id="workflow-action-name" value={name} onChange={(event) => setName(event.target.value)} className="w-full rounded border border-edge-input bg-surface px-2.5 py-1.5 text-sm text-fg mb-3" />
      <label className="block text-xs font-medium text-fg-muted mb-1" htmlFor="workflow-action-type">Type</label>
      <select id="workflow-action-type" value={type} onChange={(event) => setType(event.target.value as ActionType)} className="w-full rounded border border-edge-input bg-surface px-2.5 py-1.5 text-sm text-fg mb-3">
        {ACTION_TYPES.map((option) => <option key={option} value={option}>{actionTypeLabel(option)}</option>)}
      </select>
      {type === 'spawn_agent' && <>
        <label className="block text-xs font-medium text-fg-muted mb-1" htmlFor="workflow-action-prompt">Prompt template</label>
        <textarea id="workflow-action-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={5} placeholder="Prompt sent to the agent when this action runs" className="w-full rounded border border-edge-input bg-surface px-2.5 py-1.5 text-sm text-fg mb-3 resize-y" />
      </>}
      <label className="block text-xs font-medium text-fg-muted mb-1" htmlFor="workflow-action-config">Configuration JSON</label>
      <textarea id="workflow-action-config" value={configText} onChange={(event) => setConfigText(event.target.value)} rows={4} className="w-full rounded border border-edge-input bg-surface px-2.5 py-1.5 text-xs font-mono text-fg mb-2 resize-y" />
      {error && <div className="text-xs text-red-400 mb-2">{error}</div>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="px-3 py-1.5 text-xs rounded border border-edge-input text-fg-muted hover:text-fg">Cancel</button>
        <button type="button" onClick={() => void save()} className="px-3 py-1.5 text-xs rounded bg-accent-emphasis text-accent-on hover:bg-accent" data-testid="workflow-save-action">Save action</button>
      </div>
    </div>
  );
}

function TransitionEditor({
  route,
  swimlanes,
  actions,
  onClose,
  onSaved,
}: {
  route: WorkflowRoute | null;
  swimlanes: Swimlane[];
  actions: Action[];
  onClose: () => void;
  onSaved: (key: string) => void;
}) {
  const saveTransition = useWorkflowStore((state) => state.saveTransition);
  const [fromId, setFromId] = useState(route?.fromId ?? ANY_COLUMN);
  const [toId, setToId] = useState(route?.toId ?? swimlanes[0]?.id ?? '');
  const [actionIds, setActionIds] = useState<string[]>(route?.transitions.map((transition) => transition.action_id) ?? []);
  const [newActionId, setNewActionId] = useState(actions[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);

  const move = (index: number, delta: number) => {
    const nextIndex = index + delta;
    if (nextIndex < 0 || nextIndex >= actionIds.length) return;
    setActionIds((current) => {
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
  };

  const save = async () => {
    if (!toId || fromId === toId) {
      setError('Choose two different columns.');
      return;
    }
    if (actionIds.length === 0) {
      setError('A transition needs at least one action.');
      return;
    }
    try {
      await saveTransition({
        fromId,
        toId,
        actionIds,
        previous: route ? {
          fromId: route.fromId,
          toId: route.toId,
          actionIds: route.transitions.map((transition) => transition.action_id),
        } : undefined,
      });
      onSaved(routeKey(fromId, toId));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save transition.');
    }
  };

  return (
    <div className="rounded-lg border border-edge-input bg-surface-raised p-4" data-testid="workflow-transition-editor">
      <div className="flex items-center justify-between mb-4">
        <div className="text-sm font-semibold text-fg">{route ? 'Edit transition' : 'New transition'}</div>
        <button type="button" onClick={onClose} className="p-1 text-fg-muted hover:text-fg" aria-label="Close transition editor"><X size={15} /></button>
      </div>
      <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2 mb-4">
        <label className="text-xs text-fg-muted">From<select value={fromId} onChange={(event) => setFromId(event.target.value)} className="mt-1 w-full rounded border border-edge-input bg-surface px-2 py-1.5 text-sm text-fg"><option value={ANY_COLUMN}>Any column</option>{swimlanes.map((lane) => <option key={lane.id} value={lane.id}>{lane.name}</option>)}</select></label>
        <ArrowRight size={16} className="mb-2 text-fg-faint" />
        <label className="text-xs text-fg-muted">To<select value={toId} onChange={(event) => setToId(event.target.value)} className="mt-1 w-full rounded border border-edge-input bg-surface px-2 py-1.5 text-sm text-fg"><option value="">Choose column</option>{swimlanes.map((lane) => <option key={lane.id} value={lane.id}>{lane.name}</option>)}</select></label>
      </div>
      <div className="text-xs font-semibold uppercase tracking-wide text-fg-faint mb-2">Ordered actions</div>
      <div className="space-y-1.5 mb-3">
        {actionIds.map((id, index) => {
          const action = actions.find((candidate) => candidate.id === id);
          return <div key={`${id}-${index}`} className="flex items-center gap-2 rounded border border-edge bg-surface px-2.5 py-2 text-sm">
            <span className="w-5 text-xs text-fg-faint">{index + 1}</span><span className="flex-1 text-fg">{action?.name ?? 'Missing action'}</span>
            <button type="button" onClick={() => move(index, -1)} disabled={index === 0} className="p-1 text-fg-muted hover:text-fg disabled:opacity-30" aria-label="Move action up"><ArrowUp size={14} /></button>
            <button type="button" onClick={() => move(index, 1)} disabled={index === actionIds.length - 1} className="p-1 text-fg-muted hover:text-fg disabled:opacity-30" aria-label="Move action down"><ArrowDown size={14} /></button>
            <button type="button" onClick={() => setActionIds((current) => current.filter((_, actionIndex) => actionIndex !== index))} className="p-1 text-fg-muted hover:text-red-400" aria-label="Remove action"><X size={14} /></button>
          </div>;
        })}
        {actionIds.length === 0 && <div className="text-xs text-fg-faint py-2">No actions yet.</div>}
      </div>
      {actions.length > 0 && <div className="flex gap-2 mb-3"><select value={newActionId} onChange={(event) => setNewActionId(event.target.value)} className="min-w-0 flex-1 rounded border border-edge-input bg-surface px-2 py-1.5 text-sm text-fg"><option value="">Choose action to add</option>{actions.map((action) => <option key={action.id} value={action.id}>{action.name}</option>)}</select><button type="button" onClick={() => { if (newActionId) { setActionIds((current) => [...current, newActionId]); setNewActionId(''); } }} disabled={!newActionId} className="px-2.5 rounded border border-edge-input text-xs text-fg-muted hover:text-fg disabled:opacity-40"><Plus size={14} className="inline mr-1" />Add</button></div>}
      {error && <div className="text-xs text-red-400 mb-2">{error}</div>}
      <div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="px-3 py-1.5 text-xs rounded border border-edge-input text-fg-muted hover:text-fg">Cancel</button><button type="button" onClick={() => void save()} className="px-3 py-1.5 text-xs rounded bg-accent-emphasis text-accent-on hover:bg-accent" data-testid="workflow-save-transition">Save transition</button></div>
    </div>
  );
}

export function WorkflowView() {
  const swimlanes = useBoardStore((state) => state.swimlanes).filter((lane) => !lane.is_archived);
  const currentProjectId = useProjectStore((state) => state.currentProject?.id ?? null);
  const { actions, transitions, loading, error, load, deleteAction } = useWorkflowStore();
  const setTransition = useWorkflowStore((state) => state.setTransition);
  const [selectedColumnId, setSelectedColumnId] = useState<string | null>(null);
  const [selectedRouteKey, setSelectedRouteKey] = useState<string | null>(null);
  const [editingTransition, setEditingTransition] = useState<WorkflowRoute | null>(null);
  const [editingAction, setEditingAction] = useState<Action | null | undefined>(undefined);
  const [selectedActionId, setSelectedActionId] = useState<string | null>(null);

  useEffect(() => { void load(); }, [load, currentProjectId]);

  const routes = useMemo<WorkflowRoute[]>(() => {
    const grouped = new Map<string, WorkflowRoute>();
    for (const transition of transitions) {
      const key = routeKey(transition.from_swimlane_id, transition.to_swimlane_id);
      const existing = grouped.get(key);
      if (existing) existing.transitions.push(transition);
      else grouped.set(key, { key, fromId: transition.from_swimlane_id, toId: transition.to_swimlane_id, transitions: [transition] });
    }
    return [...grouped.values()].map((route) => ({ ...route, transitions: [...route.transitions].sort((a, b) => a.execution_order - b.execution_order) }));
  }, [transitions]);

  const visibleRoutes = useMemo(() => selectedColumnId
    ? routes.filter((route) => routeInvolvesColumn(route, selectedColumnId))
    : routes, [routes, selectedColumnId]);
  const selectedRoute = routes.find((route) => route.key === selectedRouteKey) ?? null;
  const selectedAction = actions.find((action) => action.id === selectedActionId) ?? null;
  const selectedActionUsage = selectedAction ? routes.filter((route) => route.transitions.some((transition) => transition.action_id === selectedAction.id)) : [];

  useEffect(() => {
    if (selectedRouteKey && routes.some((route) => route.key === selectedRouteKey)) return;
    setSelectedRouteKey(visibleRoutes[0]?.key ?? null);
  }, [routes, selectedRouteKey, visibleRoutes]);

  useEffect(() => {
    if (selectedActionId && actions.some((action) => action.id === selectedActionId)) return;
    setSelectedActionId(selectedRoute?.transitions[0]?.action_id ?? null);
  }, [actions, selectedActionId, selectedRoute]);

  const handleDeleteRoute = async (route: WorkflowRoute) => {
    if (!window.confirm(`Remove the transition ${routeLabel(route, swimlanes)}? Its actions will remain available.`)) return;
    await setTransition(route.fromId, route.toId, []);
    setSelectedRouteKey(null);
  };

  const handleDeleteAction = async (action: Action) => {
    const usage = routes.filter((route) => route.transitions.some((transition) => transition.action_id === action.id));
    const message = usage.length > 0
      ? `Delete “${action.name}”? This will also remove it from ${usage.length} transition${usage.length === 1 ? '' : 's'} and cannot be undone.`
      : `Delete “${action.name}”? This cannot be undone.`;
    if (!window.confirm(message)) return;
    await deleteAction(action.id);
    setSelectedActionId(null);
  };

  return (
    <div className="h-full flex flex-col bg-surface" data-testid="workflow-view">
      <div className="flex items-center justify-between px-5 py-4 border-b border-edge">
        <div><h1 className="text-lg font-semibold text-fg">Workflow</h1><p className="text-xs text-fg-muted mt-0.5">Configure transitions between columns and the actions they run.</p></div>
        <button type="button" onClick={() => void load()} disabled={loading} className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded border border-edge-input text-fg-muted hover:text-fg disabled:opacity-50" data-testid="workflow-refresh"><RefreshCw size={13} className={loading ? 'animate-spin' : ''} />Refresh</button>
      </div>
      {error && <div className="mx-5 mt-3 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</div>}
      <div className="flex flex-1 min-h-0 divide-x divide-edge">
        <aside className="w-56 shrink-0 overflow-y-auto p-3" data-testid="workflow-columns">
          <div className="flex items-center justify-between px-2 mb-2"><span className="text-[11px] font-semibold uppercase tracking-wide text-fg-faint">Columns</span><span className="text-[11px] text-fg-faint">{swimlanes.length}</span></div>
          <button type="button" onClick={() => setSelectedColumnId(null)} className={`w-full flex items-center gap-2 px-2.5 py-2 rounded text-sm text-left ${selectedColumnId === null ? 'bg-surface-hover text-fg' : 'text-fg-muted hover:text-fg hover:bg-surface-hover/50'}`}><GitBranch size={14} />All columns</button>
          {swimlanes.map((lane) => <button key={lane.id} type="button" onClick={() => setSelectedColumnId(lane.id)} className={`w-full flex items-center gap-2 px-2.5 py-2 rounded text-sm text-left ${selectedColumnId === lane.id ? 'bg-surface-hover text-fg' : 'text-fg-muted hover:text-fg hover:bg-surface-hover/50'}`}><span className="h-2 w-2 rounded-full" style={{ backgroundColor: lane.color }} /><span className="truncate">{lane.name}</span></button>)}
        </aside>
        <section className="w-[22rem] shrink-0 overflow-y-auto p-3" data-testid="workflow-transitions">
          <div className="flex items-center justify-between px-2 mb-2"><span className="text-[11px] font-semibold uppercase tracking-wide text-fg-faint">Transitions</span><button type="button" onClick={() => setEditingTransition({ key: '', fromId: selectedColumnId ?? ANY_COLUMN, toId: swimlanes.find((lane) => lane.id !== selectedColumnId)?.id ?? swimlanes[0]?.id ?? '', transitions: [] })} className="p-1 text-fg-muted hover:text-fg" aria-label="Add transition" data-testid="workflow-add-transition"><Plus size={15} /></button></div>
          {visibleRoutes.length === 0 && <div className="px-2 py-6 text-xs text-fg-faint">No transitions configured for this selection.</div>}
          <div className="space-y-1">{visibleRoutes.map((route) => <button key={route.key} type="button" onClick={() => { setSelectedRouteKey(route.key); setSelectedActionId(route.transitions[0]?.action_id ?? null); setEditingTransition(null); }} className={`w-full text-left rounded border px-3 py-2.5 transition-colors ${selectedRouteKey === route.key ? 'border-accent/60 bg-accent/10' : 'border-transparent hover:border-edge-input hover:bg-surface-hover/40'}`}><div className="flex items-center gap-2 text-sm text-fg"><span className="truncate">{columnName(route.fromId, swimlanes)}</span><ArrowRight size={13} className="shrink-0 text-fg-faint" /><span className="truncate">{columnName(route.toId, swimlanes)}</span></div><div className="mt-1 text-[11px] text-fg-faint">{route.transitions.length} action{route.transitions.length === 1 ? '' : 's'}</div></button>)}</div>
          <button type="button" onClick={() => setEditingTransition({ key: '', fromId: selectedColumnId ?? ANY_COLUMN, toId: swimlanes.find((lane) => lane.id !== selectedColumnId)?.id ?? swimlanes[0]?.id ?? '', transitions: [] })} className="mt-3 flex items-center gap-1.5 px-2 text-xs text-accent-fg hover:text-accent" data-testid="workflow-add-transition-link"><Plus size={13} />Add transition</button>
        </section>
        <main className="flex-1 min-w-0 overflow-y-auto p-5" data-testid="workflow-detail">
          {editingTransition ? <TransitionEditor key={editingTransition.key || 'new'} route={editingTransition.key ? editingTransition : null} swimlanes={swimlanes} actions={actions} onClose={() => setEditingTransition(null)} onSaved={(key) => { setEditingTransition(null); setSelectedRouteKey(key); }} /> : selectedRoute ? <>
            <div className="flex items-start justify-between gap-4 mb-5"><div><div className="flex items-center gap-2 text-lg font-semibold text-fg"><span>{columnName(selectedRoute.fromId, swimlanes)}</span><ArrowRight size={17} className="text-fg-faint" /><span>{columnName(selectedRoute.toId, swimlanes)}</span></div><p className="text-xs text-fg-muted mt-1">Actions run in the order shown below.</p></div><div className="flex gap-1"><button type="button" onClick={() => setEditingTransition(selectedRoute)} className="flex items-center gap-1 px-2.5 py-1.5 rounded border border-edge-input text-xs text-fg-muted hover:text-fg"><Pencil size={13} />Edit</button><button type="button" onClick={() => void handleDeleteRoute(selectedRoute)} className="p-1.5 rounded border border-edge-input text-fg-muted hover:text-red-400" aria-label="Delete transition"><Trash2 size={14} /></button></div></div>
            <div className="text-[11px] font-semibold uppercase tracking-wide text-fg-faint mb-2">Ordered actions</div>
            <div className="space-y-2">{selectedRoute.transitions.map((transition, index) => { const action = actions.find((candidate) => candidate.id === transition.action_id); return <button type="button" key={transition.id} onClick={() => setSelectedActionId(transition.action_id)} className={`w-full flex items-center gap-3 rounded-lg border px-3 py-3 text-left ${selectedActionId === transition.action_id ? 'border-accent/60 bg-accent/10' : 'border-edge-input hover:bg-surface-hover/40'}`}><span className="flex h-6 w-6 items-center justify-center rounded-full bg-surface-hover text-xs text-fg-faint">{index + 1}</span><span className="flex-1 min-w-0"><span className="block text-sm text-fg truncate">{action?.name ?? 'Missing action'}</span><span className="block text-[11px] text-fg-muted">{action ? actionTypeLabel(action.type) : 'Action no longer exists'}</span></span><ChevronRight size={15} className="text-fg-faint" /></button>; })}</div>
            {selectedAction && <div className="mt-5 rounded-lg border border-edge-input p-4"><div className="flex items-start justify-between"><div><div className="text-sm font-semibold text-fg">{selectedAction.name}</div><div className="mt-0.5 text-xs text-fg-muted">{actionTypeLabel(selectedAction.type)}</div></div><div className="flex gap-1"><button type="button" onClick={() => setEditingAction(selectedAction)} className="p-1.5 text-fg-muted hover:text-fg" aria-label="Edit action"><Pencil size={14} /></button><button type="button" onClick={() => void handleDeleteAction(selectedAction)} className="p-1.5 text-fg-muted hover:text-red-400" aria-label="Delete action"><Trash2 size={14} /></button></div></div>{selectedAction.type === 'spawn_agent' && <div className="mt-3"><div className="text-[11px] font-semibold uppercase tracking-wide text-fg-faint mb-1">Prompt template</div><pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-surface-raised p-3 text-xs text-fg-muted">{String(parseConfig(selectedAction.config_json).promptTemplate ?? '(No prompt configured)')}</pre></div>}<div className="mt-3 text-[11px] text-fg-faint">Used by {selectedActionUsage.length} transition{selectedActionUsage.length === 1 ? '' : 's'}{selectedActionUsage.length > 0 && `: ${selectedActionUsage.map((route) => routeLabel(route, swimlanes)).join(', ')}`}</div></div>}
            {editingAction !== undefined && <ActionForm action={editingAction} onCancel={() => setEditingAction(undefined)} onSaved={(saved) => { setEditingAction(undefined); setSelectedActionId(saved.id); }} />}
          </> : <div className="h-full flex items-center justify-center text-center text-fg-faint"><div><GitBranch size={28} className="mx-auto mb-2 opacity-50" /><p className="text-sm">Select a transition to inspect its actions.</p><p className="mt-1 text-xs">Or create a new transition from the list.</p></div></div>}
          {!editingTransition && <button type="button" onClick={() => setEditingAction(null)} className="mt-5 flex items-center gap-1.5 text-xs text-accent-fg hover:text-accent" data-testid="workflow-add-action"><Plus size={13} />Create action</button>}
          {editingAction !== undefined && !selectedRoute && <ActionForm action={editingAction} onCancel={() => setEditingAction(undefined)} onSaved={(saved) => { setEditingAction(undefined); setSelectedActionId(saved.id); }} />}
        </main>
      </div>
    </div>
  );
}
