import React from 'react';
import { useDispatch, useSelector } from 'react-redux';

import type { RootState } from '../../store';
import { selectRun, setViewMode } from '../../store/slices/modelEvalSlice';
import { ModelEvalCreatePanel } from './ModelEvalCreatePanel';
import { ModelEvalDetailView } from './ModelEvalDetailView';
import { ModelEvalRunList } from './ModelEvalRunList';

export const ModelEvalView: React.FC = () => {
  const dispatch = useDispatch();
  const viewMode = useSelector((state: RootState) => state.modelEval.viewMode);

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {viewMode === 'create' ? (
        <ModelEvalCreatePanel onBack={() => dispatch(setViewMode('list'))} />
      ) : viewMode === 'detail' ? (
        <ModelEvalDetailView onBack={() => dispatch(selectRun(null))} />
      ) : (
        <ModelEvalRunList onCreate={() => dispatch(setViewMode('create'))} />
      )}
    </div>
  );
};
