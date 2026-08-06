import React from 'react';
import { useDispatch, useSelector } from 'react-redux';
import type { RootState } from '../../store';
import {
  setViewMode,
  selectRun,
} from '../../store/slices/benchmarkSlice';
import { BenchmarkCreatePanel } from './BenchmarkCreatePanel';
import { BenchmarkReportView } from './BenchmarkReportView';
import { BenchmarkRunList } from './BenchmarkRunList';

interface BenchmarkViewProps {
  isSidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onNewChat: () => void;
  updateBadge?: React.ReactNode;
}

export const BenchmarkView: React.FC<BenchmarkViewProps> = ({
  isSidebarCollapsed,
  onToggleSidebar,
  onNewChat,
  updateBadge,
}) => {
  const dispatch = useDispatch();
  const viewMode = useSelector((state: RootState) => state.benchmark.viewMode);

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {viewMode === 'create' ? (
        <BenchmarkCreatePanel onBack={() => dispatch(setViewMode('list'))} />
      ) : viewMode === 'detail' ? (
        <BenchmarkReportView
          onBack={() => dispatch(selectRun(null))}
          onNewChat={onNewChat}
        />
      ) : (
        <BenchmarkRunList
          isSidebarCollapsed={isSidebarCollapsed}
          onToggleSidebar={onToggleSidebar}
          onNewChat={onNewChat}
          updateBadge={updateBadge}
          onCreate={() => dispatch(setViewMode('create'))}
        />
      )}
    </div>
  );
};
