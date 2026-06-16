'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import TerminalWorkspace from '../components/TerminalWorkspace';

function TerminalPageInner() {
  const searchParams = useSearchParams();
  const sessionId = searchParams.get('sessionId') || '';
  if (!sessionId) {
    return (
      <div className="min-h-screen flex items-center justify-center text-red-600" data-testid="no-session">
        缺少 sessionId 参数
      </div>
    );
  }
  return <TerminalWorkspace sessionId={sessionId} />;
}

export default function TerminalPage() {
  return (
    <Suspense fallback={<div className="p-8">加载中…</div>}>
      <TerminalPageInner />
    </Suspense>
  );
}
