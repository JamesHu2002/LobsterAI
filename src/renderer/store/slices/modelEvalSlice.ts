import { createSlice, PayloadAction } from '@reduxjs/toolkit';

import type {
  LmEvalInstallInfo,
  ModelEvalRun,
  ModelEvalTaskResult,
  ModelEvalViewMode,
} from '../../../modelEval/types';

type ModelEvalDataStatus = 'idle' | 'loading' | 'ready' | 'error';

interface ModelEvalState {
  runs: ModelEvalRun[];
  selectedRunId: string | null;
  viewMode: ModelEvalViewMode;
  installStatus: LmEvalInstallInfo | null;
  taskResults: ModelEvalTaskResult[];
  runListStatus: ModelEvalDataStatus;
  error: string | null;
}

const initialState: ModelEvalState = {
  runs: [],
  selectedRunId: null,
  viewMode: 'list',
  installStatus: null,
  taskResults: [],
  runListStatus: 'idle',
  error: null,
};

const modelEvalSlice = createSlice({
  name: 'modelEval',
  initialState,
  reducers: {
    setRunListStatus(state, action: PayloadAction<ModelEvalDataStatus>) {
      state.runListStatus = action.payload;
    },
    setError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
    setRuns(state, action: PayloadAction<ModelEvalRun[]>) {
      state.runs = action.payload;
      state.runListStatus = 'ready';
    },
    addRun(state, action: PayloadAction<ModelEvalRun>) {
      if (!state.runs.some((r) => r.id === action.payload.id)) {
        state.runs.unshift(action.payload);
      }
    },
    updateRun(state, action: PayloadAction<ModelEvalRun>) {
      const index = state.runs.findIndex((r) => r.id === action.payload.id);
      if (index !== -1) {
        state.runs[index] = action.payload;
      } else {
        state.runs.unshift(action.payload);
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
      state.taskResults = [];
      if (action.payload) {
        state.taskResults = [];
      }
    },
    setViewMode(state, action: PayloadAction<ModelEvalViewMode>) {
      state.viewMode = action.payload;
    },
    setInstallStatus(state, action: PayloadAction<LmEvalInstallInfo | null>) {
      state.installStatus = action.payload;
    },
    setTaskResults(state, action: PayloadAction<ModelEvalTaskResult[]>) {
      state.taskResults = action.payload;
    },
  },
});

export const {
  setRunListStatus,
  setError,
  setRuns,
  addRun,
  updateRun,
  removeRun,
  selectRun,
  setViewMode,
  setInstallStatus,
  setTaskResults,
} = modelEvalSlice.actions;

export default modelEvalSlice.reducer;
