'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import HistoryDetailPage from '../../components/HistoryDetailPage';

function DetailInner() {
  const sp = useSearchParams();
  const recordId = sp.get('recordId') || null;
  if (!recordId) {
    return (
      <div className="min-h-screen flex items-center justify-center text-red-600" data-testid="no-record-id">
        缺少 recordId 参数
      </div>
    );
  }
  return <HistoryDetailPage recordId={recordId} />;
}

export default function HistoryDetailRoute() {
  return (
    <Suspense fallback={<div className="p-8">加载中…</div>}>
      <DetailInner />
    </Suspense>
  );
}
