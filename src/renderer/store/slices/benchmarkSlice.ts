import { createSlice, PayloadAction } from '@reduxjs/toolkit';

import type {
  BenchmarkDatasetInfo,
  BenchmarkProgressUpdateEvent,
  BenchmarkReport,
  BenchmarkRun,
  BenchmarkTaskResult,
  BenchmarkViewMode,
  DatasetStatus,
} from '../../../benchmark/types';

type BenchmarkDataStatus = 'idle' | 'loading' | 'ready' | 'error';

interface BenchmarkState {
  runs: BenchmarkRun[];
  selectedRunId: string | null;
  viewMode: BenchmarkViewMode;
  datasets: BenchmarkDatasetInfo[];
  datasetStatus: Record<string, DatasetStatus>;
  datasetLoading: Record<string, boolean>;
  report: BenchmarkReport | null;
  reportStatus: BenchmarkDataStatus;
  taskResults: BenchmarkTaskResult[];
  taskResultsTotal: number;
  taskResultsHasMore: boolean;
  runListStatus: BenchmarkDataStatus;
  error: string | null;
}

const initialState: BenchmarkState = {
  runs: [],
  selectedRunId: null,
  viewMode: 'list',
  datasets: [],
  datasetStatus: {},
  datasetLoading: {},
  report: null,
  reportStatus: 'idle',
  taskResults: [],
  taskResultsTotal: 0,
  taskResultsHasMore: false,
  runListStatus: 'idle',
  error: null,
};

const benchmarkSlice = createSlice({
  name: 'benchmark',
  initialState,
  reducers: {
    setRunListStatus(state, action: PayloadAction<BenchmarkDataStatus>) {
      state.runListStatus = action.payload;
    },
    setError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
    setRuns(state, action: PayloadAction<BenchmarkRun[]>) {
      state.runs = action.payload;
      state.runListStatus = 'ready';
    },
    addRun(state, action: PayloadAction<BenchmarkRun>) {
      if (!state.runs.some((r) => r.id === action.payload.id)) {
        state.runs.unshift(action.payload);
      }
    },
    updateRun(state, action: PayloadAction<BenchmarkRun>) {
      const index = state.runs.findIndex((r) => r.id === action.payload.id);
      if (index !== -1) {
        state.runs[index] = action.payload;
      }
    },
    updateRunProgress(state, action: PayloadAction<BenchmarkProgressUpdateEvent>) {
      const run = state.runs.find((r) => r.id === action.payload.runId);
      if (run) {
        run.done = action.payload.done;
        run.total = action.payload.total;
        run.passed = action.payload.passed;
        run.failed = action.payload.failed;
        if (run.done >= run.total && run.status === 'running') {
          run.status = 'completed';
        }
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
      if (action.payload) {
        state.report = null;
        state.taskResults = [];
        state.taskResultsTotal = 0;
        state.taskResultsHasMore = false;
      }
    },
    setViewMode(state, action: PayloadAction<BenchmarkViewMode>) {
      state.viewMode = action.payload;
    },
    setDatasets(state, action: PayloadAction<BenchmarkDatasetInfo[]>) {
      state.datasets = action.payload;
    },
    updateDataset(state, action: PayloadAction<BenchmarkDatasetInfo>) {
      const index = state.datasets.findIndex((d) => d.id === action.payload.id);
      if (index !== -1) {
        state.datasets[index] = action.payload;
      } else {
        state.datasets.push(action.payload);
      }
    },
    setDatasetStatus(state, action: PayloadAction<{ datasetId: string; status: DatasetStatus }>) {
      state.datasetStatus[action.payload.datasetId] = action.payload.status;
    },
    setDatasetLoading(state, action: PayloadAction<{ datasetId: string; loading: boolean }>) {
      state.datasetLoading[action.payload.datasetId] = action.payload.loading;
    },
    setReport(state, action: PayloadAction<BenchmarkReport | null>) {
      state.report = action.payload;
      state.reportStatus = action.payload ? 'ready' : 'idle';
    },
    setReportStatus(state, action: PayloadAction<BenchmarkDataStatus>) {
      state.reportStatus = action.payload;
    },
    setTaskResults(state, action: PayloadAction<{ results: BenchmarkTaskResult[]; total: number; hasMore: boolean }>) {
      state.taskResults = action.payload.results;
      state.taskResultsTotal = action.payload.total;
      state.taskResultsHasMore = action.payload.hasMore;
    },
    appendTaskResult(state, action: PayloadAction<BenchmarkTaskResult>) {
      const exists = state.taskResults.some((r) => r.id === action.payload.id);
      if (!exists) {
        state.taskResults.push(action.payload);
        state.taskResultsTotal += 1;
      } else {
        state.taskResults = state.taskResults.map((r) =>
          r.id === action.payload.id ? action.payload : r,
        );
      }
    },
    appendTaskResults(state, action: PayloadAction<{ results: BenchmarkTaskResult[]; total: number; hasMore: boolean }>) {
      state.taskResults = [...state.taskResults, ...action.payload.results];
      state.taskResultsTotal = action.payload.total;
      state.taskResultsHasMore = action.payload.hasMore;
    },
  },
});

export const {
  setRunListStatus,
  setError,
  setRuns,
  addRun,
  updateRun,
  updateRunProgress,
  removeRun,
  selectRun,
  setViewMode,
  setDatasets,
  updateDataset,
  setDatasetStatus,
  setDatasetLoading,
  setReport,
  setReportStatus,
  setTaskResults,
  appendTaskResult,
  appendTaskResults,
} = benchmarkSlice.actions;

export default benchmarkSlice.reducer;
