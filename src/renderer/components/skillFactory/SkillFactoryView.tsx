import React from 'react';
import { useDispatch, useSelector } from 'react-redux';

import type { RootState } from '../../store';
import { selectRun, setViewMode } from '../../store/slices/skillFactorySlice';
import { SkillFactoryCreatePanel } from './SkillFactoryCreatePanel';
import { SkillFactoryDetailView } from './SkillFactoryDetailView';
import { SkillFactoryRunList } from './SkillFactoryRunList';

interface SkillFactoryViewProps {
  onNewChat: () => void;
}

export const SkillFactoryView: React.FC<SkillFactoryViewProps> = ({ onNewChat }) => {
  const dispatch = useDispatch();
  const viewMode = useSelector((state: RootState) => state.skillFactory.viewMode);

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {viewMode === 'create' ? (
        <SkillFactoryCreatePanel onBack={() => dispatch(setViewMode('list'))} />
      ) : viewMode === 'detail' ? (
        <SkillFactoryDetailView onBack={() => dispatch(selectRun(null))} onNewChat={onNewChat} />
      ) : (
        <SkillFactoryRunList onCreate={() => dispatch(setViewMode('create'))} />
      )}
    </div>
  );
};
