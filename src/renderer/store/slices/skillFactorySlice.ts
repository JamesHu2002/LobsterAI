import { createSlice, PayloadAction } from '@reduxjs/toolkit';

import type {
  SkillFactoryRun,
  SkillFactoryViewMode,
} from '../../../skillFactory/types';

type SkillFactoryDataStatus = 'idle' | 'loading' | 'ready' | 'error';

interface SkillFactoryState {
  runs: SkillFactoryRun[];
  selectedRunId: string | null;
  viewMode: SkillFactoryViewMode;
  runListStatus: SkillFactoryDataStatus;
  error: string | null;
}

const initialState: SkillFactoryState = {
  runs: [],
  selectedRunId: null,
  viewMode: 'list',
  runListStatus: 'idle',
  error: null,
};

const skillFactorySlice = createSlice({
  name: 'skillFactory',
  initialState,
  reducers: {
    setRunListStatus(state, action: PayloadAction<SkillFactoryDataStatus>) {
      state.runListStatus = action.payload;
    },
    setError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
    setRuns(state, action: PayloadAction<SkillFactoryRun[]>) {
      state.runs = action.payload;
      state.runListStatus = 'ready';
    },
    addRun(state, action: PayloadAction<SkillFactoryRun>) {
      if (!state.runs.some((r) => r.id === action.payload.id)) {
        state.runs.unshift(action.payload);
      }
    },
    updateRun(state, action: PayloadAction<SkillFactoryRun>) {
      const index = state.runs.findIndex((r) => r.id === action.payload.id);
      if (index !== -1) {
        state.runs[index] = action.payload;
      } else {
        state.runs.unshift(action.payload);
      }
    },
    updateRunStage(state, action: PayloadAction<{ runId: string; stage: SkillFactoryRun['stage'] }>) {
      const run = state.runs.find((r) => r.id === action.payload.runId);
      if (run) {
        run.stage = action.payload.stage;
      }
    },
    removeRun(state, action: PayloadAction<string>) {
      state.runs = state.runs.filter((r) => r.id !== action.payload);
      if (state.selectedRunId === action.payload) {
        state.selectedRunId = null;
        state.viewMode = 'list';
      }
    },
    selectRun(state, action: PayloadAction<string | null>) {
      state.selectedRunId = action.payload;
      state.viewMode = action.payload ? 'detail' : 'list';
    },
    setViewMode(state, action: PayloadAction<SkillFactoryViewMode>) {
      state.viewMode = action.payload;
    },
  },
});

export const {
  setRunListStatus,
  setError,
  setRuns,
  addRun,
  updateRun,
  updateRunStage,
  removeRun,
  selectRun,
  setViewMode,
} = skillFactorySlice.actions;

export default skillFactorySlice.reducer;
