'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createTab } from '../lib/api';
import { useWorkspace } from './WorkspaceProvider';
import WorkspaceDialog from './WorkspaceDialog';

export default function HomePage() {
  const router = useRouter();
  const { workspaces, createWorkspace, pendingActions, error } = useWorkspace();
  const [cwd, setCwd] = useState('');
  const [opening, setOpening] = useState<string | null>(null);
  const openingRef = useRef<string | null>(null);

  async function openWorkspace(workspaceId: string) {
    if (openingRef.current) return;
    openingRef.current = workspaceId;
    setOpening(workspaceId);
    try {
      const { tab } = await createTab(workspaceId, { requestId: crypto.randomUUID() });
      router.push(`/terminal?workspace=${encodeURIComponent(workspaceId)}&tab=${encodeURIComponent(tab.id)}`);
    } finally {
      openingRef.current = null;
      setOpening(null);
    }
  }

  return (
    <main className="p-8">
      <h1 className="text-xl font-semibold">工作区概览</h1>
      <WorkspaceDialog
        cwd={cwd}
        pending={pendingActions.has('create-workspace')}
        onCwdChange={setCwd}
        onSubmit={() => void createWorkspace(cwd.trim()).then(() => setCwd(''))}
      />
      {error && <p role="alert" className="mt-2 text-red-500">{error}</p>}
      <section className="mt-8 grid gap-3">
        {workspaces.map((workspace) => (
          <button
            key={workspace.id}
            type="button"
            onClick={() => void openWorkspace(workspace.id)}
            disabled={opening === workspace.id}
            className="rounded border p-4 text-left"
          >
            <strong>{workspace.displayName || workspace.id}</strong>
            <span className="ml-3 text-xs opacity-60">{workspace.sessionCount || 0} 个活动标签</span>
          </button>
        ))}
        {workspaces.length === 0 && <p className="opacity-60">添加工作区后开始使用终端。</p>}
      </section>
    </main>
  );
}
