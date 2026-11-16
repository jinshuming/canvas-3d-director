/**
 * The 场景生成 editor's agent log, as AgentPanel lines: the conversation (or, for a scene laid out
 * on the canvas, its prompt and blockout), then each generation's stages from its job log.
 */
import type { ChatItem } from '../../scenegen/agent/loop.ts';
import type { Layout } from '../../scenegen/core/types.ts';
import type { Project } from '../../scenegen/web/api.ts';
import type { ChatItem as PanelItem } from '../agent/useAgent.ts';
import type { GenResult } from './sceneResults.ts';

/** How the scene agent's tools, the fast blockout and the generation's stages read in the log. */
export const SCENE_TOOL_LABEL: Record<string, string> = {
  quick_layout: '快速摆白模', get_layout: '查看白模', set_room: '设置房间', set_outdoor: '设为室外', add_opening: '添加门窗',
  place_objects: '摆放物体', update_object: '调整物体', remove_objects: '移除物体', check_layout: '检查白模', set_style: '设置风格',
  look: '观察白模', choose_capture_point: '选择拍摄点', set_capture_point: '设置拍摄点', generate_scene: '生成场景',
  start: '开始生成', conditions: '渲染白模条件图', pano: '生成全景图', scale: '测量尺度', scene: 'JST-2 建环境', fill: '检测并补缺口',
  objects: 'SAM 3D 生成物体', compose: '合成', verify: '校验', done: '完成',
};

/** 室内 W×D×H m, or 室外. */
export const roomText = (l: Layout) => (l.room ? `室内 ${l.room.width}×${l.room.depth}×${l.room.height} m` : '室外');

/** One line per object; ★ marks the key ones (SAM 3D). */
export const objectLines = (l: Layout) => l.objects.map((o) => `${o.key ? '★ ' : ''}${o.id}: ${o.label}`).join('\n');

type LoggedJob = { kind: string; log: string[]; status: string; error?: string };

/**
 * The whole log. The latest generation's stages go right after the agent's generate_scene call
 * when it started one, else at the end.
 */
export function sceneLog(project: Project, chat: ChatItem[]): PanelItem[] {
  let seq = 0;
  const nid = () => `i${++seq}`;

  const fromChat = (): PanelItem[] => chat.map((it): PanelItem => (it.role === 'tool'
    ? { kind: 'tool', id: nid(), name: it.name, args: JSON.stringify(it.args), status: it.isError ? 'error' : 'done', result: it.text, image: it.image }
    : it.role === 'user' ? { kind: 'user', id: nid(), text: it.text } : { kind: 'assistant', id: nid(), text: it.text }));

  // A project laid out on the canvas has no chat: its prompt and its blockout start the log.
  const fromCanvas = (): PanelItem[] => {
    const l = project.layout;
    if (!l.objects.length) return [];
    const out: PanelItem[] = [];
    if (l.prompt) out.push({ kind: 'user', id: nid(), text: l.prompt });
    out.push({ kind: 'tool', id: nid(), name: 'quick_layout', args: JSON.stringify({ title: l.title, objects: l.objects.length }), status: 'done',
      result: `${roomText(l)}\n${objectLines(l)}\n风格：${l.style.summary}` });
    return out;
  };

  // One job's steps from its log, and how it ended: a generation's summary, an expansion's, or the error.
  const fromJob = (job: LoggedJob, latest: boolean): PanelItem[] => {
    const out: PanelItem[] = job.log.map((line, i): PanelItem => {
      const m = /^\[(\d+)s\] (\w+): (.*)$/.exec(line);
      const last = i === job.log.length - 1;
      return { kind: 'tool', id: nid(), name: m?.[2] ?? 'start', args: JSON.stringify({ message: m?.[3] ?? line }), status: latest && last && job.status === 'running' ? 'running' : 'done', result: `${m ? `${m[1]} 秒 · ` : ''}${m?.[3] ?? line}` };
    });
    const expand = job.log.some((l) => / expand: /.test(l));
    const r = project.result as GenResult | null | undefined;
    if (job.status === 'done' && expand) out.push({ kind: 'assistant', id: nid(), text: `已从你选的视角扩展场景：${job.log.find((l) => / done: /.test(l))?.replace(/^\[\d+s\] done: /, '') ?? '完成'}。` });
    else if (job.status === 'done' && r && latest) {
      const objs = (r.objects ?? []).filter((o) => o.file);
      out.push({ kind: 'assistant', id: nid(), text: `场景生成好了：与白模 **${Math.round((r.alignment?.within25 ?? 0) * 100)}%** 一致，${objs.length ? `${objs.length} 个关键物体由 SAM 3D 单独生成（${objs.map((o) => o.label).join('、')}），` : ''}用了 ${r.credits} 额度。可以在左边看 3D 场景；走到有缺口的地方点右下角 Expand 补全；或继续说要改什么。` });
    } else if (job.status === 'done') out.push({ kind: 'assistant', id: nid(), text: '场景生成好了。' });
    if (job.status === 'failed') out.push({ kind: 'error', id: nid(), text: `${expand ? '扩展' : '生成'}失败：${job.error ?? job.log[job.log.length - 1] ?? '未知错误'}` });
    return out;
  };

  // Every run that left a log - earlier ones are kept in the result - then the latest.
  const fromJobs = (): PanelItem[] => {
    const job = project.job;
    if (!job || job.kind !== 'text') return [];
    const past = ((project.result as { pastJobs?: LoggedJob[] } | null | undefined)?.pastJobs ?? []).filter((j) => j.kind === 'text');
    return [...past.flatMap((j) => fromJob(j, false)), ...fromJob(job, true)];
  };

  const talk = chat.length ? fromChat() : fromCanvas();
  const gen = fromJobs();
  const at = chat.map((it) => (it.role === 'tool' ? it.name : '')).lastIndexOf('generate_scene');
  return at >= 0 ? [...talk.slice(0, at + 1), ...gen, ...talk.slice(at + 1)] : [...talk, ...gen];
}
