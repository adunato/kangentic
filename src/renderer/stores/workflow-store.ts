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
  /**
   * Save a route, relocating it when its endpoints changed. The old route is
   * removed first and restored if creating the new route fails, so a failed
   * edit never silently leaves two routes or loses the prior configuration.
   */
  saveTransition: (input: {
    fromId: string;
    toId: string;
    actionIds: string[];
    previous?: { fromId: string; toId: string; actionIds: string[] };
  }) => Promise<void>;
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

  saveTransition: async ({ fromId, toId, actionIds, previous }) => {
    if (!previous || (previous.fromId === fromId && previous.toId === toId)) {
      await get().setTransition(fromId, toId, actionIds);
      return;
    }

    // The IPC contract replaces the complete action list for one endpoint
    // pair. Remove the old pair before writing the relocated pair; if the new
    // write fails, restore the old list so the user can retry safely.
    await window.electronAPI.transitions.set(previous.fromId, previous.toId, []);
    try {
      await window.electronAPI.transitions.set(fromId, toId, actionIds);
    } catch (error) {
      try {
        await window.electronAPI.transitions.set(previous.fromId, previous.toId, previous.actionIds);
      } catch (rollbackError) {
        throw new Error(
          `Could not save the relocated transition (${errorMessage(error)}). `
          + `Restoring the previous route also failed (${errorMessage(rollbackError)}).`,
        );
      }
      throw error;
    }
    await get().load();
  },
}));
