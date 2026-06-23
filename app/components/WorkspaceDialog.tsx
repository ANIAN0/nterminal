'use client';

/**
 * 新建工作区对话框。
 * 把 cwd 输入与提交动作以受控方式暴露给父组件，父组件负责真正调用 createWorkspace。
 */

interface WorkspaceDialogProps {
  cwd: string;
  pending: boolean;
  onCwdChange: (value: string) => void;
  onSubmit: () => void;
}

export default function WorkspaceDialog({ cwd, pending, onCwdChange, onSubmit }: WorkspaceDialogProps) {
  return (
    <form
      className="mt-6 flex max-w-2xl gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (cwd.trim()) onSubmit();
      }}
    >
      <label className="sr-only" htmlFor="workspace-cwd">工作区目录</label>
      <input
        id="workspace-cwd"
        value={cwd}
        onChange={(event) => onCwdChange(event.target.value)}
        placeholder="输入工作区目录"
        className="flex-1 rounded border px-3 py-2"
      />
      <button type="submit" disabled={pending || !cwd.trim()} className="rounded border px-4 py-2">
        {pending ? '添加中…' : '添加工作区'}
      </button>
    </form>
  );
}
