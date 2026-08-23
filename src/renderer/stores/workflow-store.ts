import { create } from 'zustand';
import type {
  Action,
  ActionCreateInput,
  ActionUpdateInput,
  SwimlaneTransition,
} from '../../shared/types';

export interface WorkflowStore {
  actions: Action[];
  transitions: SwimlaneTransition[];
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
  createAction: (input: ActionCreateInput) => Promise<Action>;
  updateAction: (input: ActionUpdateInput) => Promise<Action>;
  deleteAction: (id: string) => Promise<void>;
  setTransition: (fromId: string, toId: string, actionIds: string[]) => Promise<void>;
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Unknown workflow error';

export const useWorkflowStore = create<WorkflowStore>((set, get) => ({
  actions: [],
  transitions: [],
  loading: false,
  error: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const [actions, transitions] = await Promise.all([
        window.electronAPI.actions.list(),
        window.electronAPI.transitions.list(),
      ]);
      set({ actions, transitions, loading: false });
    } catch (error) {
      set({ loading: false, error: errorMessage(error) });
    }
  },

  createAction: async (input) => {
    const action = await window.electronAPI.actions.create(input);
    await get().load();
    return action;
  },

  updateAction: async (input) => {
    const action = await window.electronAPI.actions.update(input);
    await get().load();
    return action;
  },

  deleteAction: async (id) => {
    await window.electronAPI.actions.delete(id);
    // The main-process repository intentionally cascades action references;
    // reload both collections so the UI reflects that canonical state.
    await get().load();
  },

  setTransition: async (fromId, toId, actionIds) => {
    await window.electronAPI.transitions.set(fromId, toId, actionIds);
    await get().load();
  },
}));
