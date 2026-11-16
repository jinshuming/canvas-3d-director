import type { Project } from '../../scenegen/web/api.ts';
import { STAGE_LABEL } from '../../scenegen/web/runner.ts';

/** Over the editor's view: the running job's progress, or why the last one failed. */
export function JobStatus({ project, failedLabel }: { project: Project; failedLabel: string }) {
  const job = project.job;
  if (job?.status === 'failed') return <div className="se-failed">{failedLabel}失败：{job.error}</div>;
  if (job?.status !== 'running') return null;
  return (
    <div className="se-progress">
      <div className="se-bar"><div style={{ width: `${Math.round(Math.max(0.03, job.progress) * 100)}%` }} /></div>
      <span><b>{STAGE_LABEL[job.stage] ?? job.stage}</b> {job.message}</span>
    </div>
  );
}
