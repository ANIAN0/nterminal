'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import HistoryDetailPage from '../../components/HistoryDetailPage';

function DetailInner() {
  const sp = useSearchParams();
  const sourceId = sp.get('sourceId') || null;
  const sessionKey = sp.get('sessionKey') || null;
  if (!sourceId || !sessionKey) {
    return (
      <div className="min-h-screen flex items-center justify-center text-red-600" data-testid="no-record-id">
        缺少 sourceId 或 sessionKey 参数
      </div>
    );
  }
  return <HistoryDetailPage sourceId={sourceId} sessionKey={sessionKey} />;
}

export default function HistoryDetailRoute() {
  return (
    <Suspense fallback={<div className="p-8">加载中…</div>}>
      <DetailInner />
    </Suspense>
  );
}
