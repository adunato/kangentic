import { afterEach, describe, expect, it, vi } from 'vitest';
import { routeInvolvesColumn } from '../../src/renderer/components/workflow/WorkflowView';
import { useWorkflowStore } from '../../src/renderer/stores/workflow-store';

function installElectronApi(overrides: {
  set?: (fromId: string, toId: string, actionIds: string[]) => Promise<void>;
  listTransitions?: () => Promise<unknown[]>;
} = {}) {
  const api = {
    actions: {
      list: vi.fn(async () => []),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    transitions: {
      list: vi.fn(overrides.listTransitions ?? (async () => [])),
      set: vi.fn(overrides.set ?? (async () => undefined)),
      getForTransition: vi.fn(async () => []),
    },
  };
  vi.stubGlobal('window', { electronAPI: api });
  return api;
}

afterEach(() => {
  vi.unstubAllGlobals();
  useWorkflowStore.setState({ actions: [], transitions: [], loading: false, error: null });
});

describe('workflow route filtering', () => {
  it('treats a wildcard source as an incoming route for its destination', () => {
    expect(routeInvolvesColumn({ fromId: '*', toId: 'planning' }, 'planning')).toBe(true);
    expect(routeInvolvesColumn({ fromId: '*', toId: 'planning' }, 'review')).toBe(false);
    expect(routeInvolvesColumn({ fromId: 'planning', toId: 'review' }, 'planning')).toBe(true);
  });
});

describe('workflow transition persistence', () => {
  it('relocates a route without leaving the old endpoint pair behind', async () => {
    const api = installElectronApi();
    await useWorkflowStore.getState().saveTransition({
      fromId: 'review',
      toId: 'done',
      actionIds: ['action-new'],
      previous: { fromId: 'planning', toId: 'review', actionIds: ['action-old'] },
    });

    expect(api.transitions.set.mock.calls).toEqual([
      ['planning', 'review', []],
      ['review', 'done', ['action-new']],
    ]);
  });

  it('restores the previous route if the relocated write fails', async () => {
    const api = installElectronApi({
      set: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('write failed'))
        .mockResolvedValueOnce(undefined),
    });

    await expect(useWorkflowStore.getState().saveTransition({
      fromId: 'review',
      toId: 'done',
      actionIds: ['action-new'],
      previous: { fromId: 'planning', toId: 'review', actionIds: ['action-old'] },
    })).rejects.toThrow('write failed');

    expect(api.transitions.set.mock.calls).toEqual([
      ['planning', 'review', []],
      ['review', 'done', ['action-new']],
      ['planning', 'review', ['action-old']],
    ]);
  });

  it('keeps same-pair edits as a single replacement', async () => {
    const api = installElectronApi();
    await useWorkflowStore.getState().saveTransition({
      fromId: 'planning',
      toId: 'review',
      actionIds: ['action-new'],
      previous: { fromId: 'planning', toId: 'review', actionIds: ['action-old'] },
    });

    expect(api.transitions.set.mock.calls).toEqual([
      ['planning', 'review', ['action-new']],
    ]);
  });
});
