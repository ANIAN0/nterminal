'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import TerminalWorkspace from '../components/TerminalWorkspace';

function TerminalPageInner() {
  const searchParams = useSearchParams();
  const workspaceId = searchParams.get('workspace') || '';
  const tabId = searchParams.get('tab') || '';
  if (!workspaceId) {
    return (
      <div className="min-h-screen flex items-center justify-center text-red-600" data-testid="no-session">
        请选择工作区
      </div>
    );
  }
  return <TerminalWorkspace workspaceId={workspaceId} tabId={tabId} />;
}

export default function TerminalPage() {
  return (
    <Suspense fallback={<div className="p-8">加载中…</div>}>
      <TerminalPageInner />
    </Suspense>
  );
}
