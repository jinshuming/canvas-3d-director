// The task suite: what creators ask the World agent for, and what the stage must look like afterwards.
//
// A task: { id, category, title, turns: [text...], budget (tool calls), lang, grade(ctx) }.
// `grade` returns { checks: { name: boolean }, detail }. Every check is a hard pass/fail on the stage
// document or the renderer's numbers - never on the model's own claims.
import { sampleShot, shotSpan } from '../src/stage/camera.ts';
import { editSpan, sortedCuts } from '../src/stage/cuts.ts';
import { measureFrame } from '../src/stage/scenecheck.ts';
import { fileToWorldPoint, placeWalkScene } from '../src/walk/placement.ts';
import {
  ang, at, byName, camDistance, camOf, clipLabel, clipsOf, dist2, doc, facingError, firstClip, FRODO, lastMoveEnd,
  shotHealth, stage, sweepDeg, sizeIn, TRAVELLER, VIKING, yawToward,
} from './lib.js';

const tools = (ctx) => ctx.turns.flatMap((t) => t.stats?.tools ?? []);
const reply = (ctx) => ctx.turns[ctx.turns.length - 1]?.reply ?? '';
const clearAll = (health) => health.length > 0 && health.every((h) => h.keys > 0 && h.clear === h.total);
const headsIn = (health) => health.length > 0 && health.every((h) => h.keys > 0 && h.framed === h.total);
const onFloor = (p) => stage().floorAt(p[0], p[2]) !== null;

// ── 1. Blocking: cast, place, perform ────────────────────────────────────────

const intro = {
  id: 'intro', category: 'blocking', title: '角色亮相：挥手 → 点头，全景推中近景', budget: 18, lang: 'zh',
  turns: ['在现代客厅里给维京女战士一个亮相：她面向镜头挥手再点头，先用全景，再推到中近景。'],
  async grade() {
    const d = doc();
    const v = byName(VIKING);
    const wave = firstClip(v, /wave/i), nod = firstClip(v, /nod/i);
    const health = shotHealth([VIKING]);
    // Wide then tight: through one pushing-in shot, or two shots of different size.
    let tighter = false;
    if (v) {
      const sizes = d.shots.filter((s) => s.keys.length).flatMap((s) => { const sp = shotSpan(s); return sp ? [sizeIn(s, sp[0], v), sizeIn(s, sp[1], v)] : []; });
      tighter = sizes.length >= 2 && Math.max(...sizes) / Math.max(0.01, Math.min(...sizes)) >= 1.5;
    }
    const cam = d.shots[0] ? camOf(d.shots[0], wave?.start ?? 0)?.cam : null;
    return {
      checks: {
        sceneSet: !!d.scene,
        vikingOnStage: !!v,
        waveThenNod: !!wave && !!nod && nod.start >= wave.end - 0.15,
        facesCamera: !!v && !!cam && facingError(v, wave?.start ?? 0, cam.position) <= 25,
        wideThenTight: tighter,
        shotsClearAndFramed: clearAll(health) && headsIn(health),
        previewed: tools({ turns: this.turns }).includes('preview'),
      },
      detail: { clips: clipsOf(v).map(clipLabel), health },
    };
  },
};

const walk = {
  id: 'walk', category: 'blocking', title: '走位 + 跟拍：窗边走到茶几前，转身看镜头，欢呼', budget: 25, lang: 'zh',
  turns: ['在现代客厅里放一个角色，让 TA 从窗边走到茶几前，停下转身看镜头，然后欢呼。镜头跟着走，最后推近。'],
  async grade() {
    const d = doc();
    const ch = d.characters[0];
    const clips = clipsOf(ch);
    const endT = lastMoveEnd(ch);
    const end = ch ? at(ch, endT + 0.05) : null;
    const metres = ch && end ? dist2(end.position, ch.position) : 0;
    const cheer = clips.find((k) => /cheer/i.test(k.name));
    const shot = d.shots.find((s) => s.keys.length);
    const cam = shot ? sampleShot(shot, Math.min(endT + 0.3, shotSpan(shot)?.[1] ?? 0)) : null;
    const health = shotHealth();
    const camTravel = shot && shot.keys.length >= 2 ? Math.hypot(...shot.keys[0].position.map((v, i) => v - shot.keys[shot.keys.length - 1].position[i])) : 0;
    return {
      checks: {
        oneCharacter: d.characters.length === 1,
        walksFar: metres > 1.5,
        endsOnFloor: !!end && onFloor(end.position),
        cheerAfterWalk: !!cheer && cheer.start >= endT - 0.05,
        facesCameraAtEnd: !!end && !!cam && Math.abs(ang(end.yaw - yawToward(end.position, cam.position))) <= 25,
        cameraMoves: camTravel > 0.4,
        framedThroughout: headsIn(health) && clearAll(health),
      },
      detail: { metres: +metres.toFixed(2), clips: clips.map(clipLabel), camTravel: +camTravel.toFixed(2), health },
    };
  },
};

const crowd = {
  id: 'crowd', category: 'blocking', title: '三人围成一圈面对面，全景看到所有人', budget: 22, lang: 'zh',
  turns: ['客厅里站三个人：维京女战士、旅行者、Frodo，围成一圈互相面对，给我一个全景镜头，能同时看到三个人。'],
  async grade() {
    const d = doc();
    const cs = d.characters;
    const ps = cs.map((c) => at(c, 0));
    const cx = ps.reduce((n, p) => n + p.position[0], 0) / (ps.length || 1);
    const cz = ps.reduce((n, p) => n + p.position[2], 0) / (ps.length || 1);
    const centre = [cx, 0, cz];
    let minGap = Infinity;
    for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) minGap = Math.min(minGap, dist2(ps[i].position, ps[j].position));
    const shot = d.shots.find((s) => s.keys.length);
    const t = shot ? (shotSpan(shot)?.[0] ?? 0) : 0;
    const seen = shot ? stage().framing(sampleShot(shot, t), 16 / 9, t) : [];
    return {
      checks: {
        threeDistinct: cs.length === 3 && new Set(cs.map((c) => c.url)).size === 3,
        allOnFloor: ps.length > 0 && ps.every((p) => onFloor(p.position) && Math.hypot(p.position[0], p.position[2]) <= 5),
        notOverlapping: minGap >= 0.7,
        faceTheCircle: ps.length > 0 && ps.every((p) => Math.abs(ang(p.yaw - yawToward(p.position, centre))) <= 45),
        shotSeesAll: seen.length === 3 && seen.every((f) => f.visible >= 0.8 && f.line_of_sight !== 'blocked'),
      },
      detail: { minGap: +minGap.toFixed(2), centre, seen: seen.map((f) => `${f.name}:${f.visible}/${f.line_of_sight}`) },
    };
  },
};

// ── 2. Camera language ───────────────────────────────────────────────────────

const lowOrbit = {
  id: 'low-orbit', category: 'camera', title: '设计镜头：低角度推近 + 环绕', budget: 18, lang: 'zh',
  turns: ['在现代客厅中间放旅行者，站着不动。给我两个不同风格的镜头：一个低角度推近，一个环绕。'],
  async grade() {
    const d = doc();
    const c = byName(TRAVELLER) ?? d.characters[0];
    const p = c ? at(c, 0).position : [0, 0, 0];
    const shots = d.shots.filter((s) => s.keys.length >= 2);
    const push = shots.find((s) => {
      const ks = [...s.keys].sort((a, b) => a.t - b.t);
      return ks[0].position[1] < ks[0].target[1] - 0.15 && camDistance(s, ks[0].t, p) - camDistance(s, ks[ks.length - 1].t, p) >= 0.4;
    });
    const orbit = shots.find((s) => s !== push && sweepDeg(s) >= 45);
    const health = shotHealth();
    return {
      checks: {
        oneCharacter: d.characters.length === 1,
        lowAnglePushIn: !!push,
        orbit45: !!orbit,
        framedThroughout: headsIn(health),
        notBlocked: clearAll(health),
        cameraOverFloor: health.every((h) => h.keys === 0 || h.overFloor === h.samples),
      },
      detail: { shots: d.shots.map((s) => `${s.name}:${s.keys.length}k sweep${sweepDeg(s)}`), health },
    };
  },
};

const english = {
  id: 'english', category: 'communication', title: '英文需求：特写 + 挥手，英文回复', budget: 14, lang: 'en',
  turns: ['Put the Traveller in the living room, have him wave at the camera, and give me a close-up.'],
  async grade() {
    const d = doc();
    const t = byName(TRAVELLER);
    const wave = firstClip(t, /wave/i);
    const shot = d.shots.find((s) => s.keys.length);
    const span = shot ? shotSpan(shot) : null;
    const cam = shot && span ? sampleShot(shot, span[0]).position : null;
    const health = shotHealth();
    return {
      checks: {
        travellerOnStage: !!t,
        waves: !!wave,
        facesCamera: !!t && !!cam && facingError(t, wave?.start ?? 0, cam) <= 25,
        closeUp: !!t && !!shot && !!span && sizeIn(shot, span[0], t) >= 0.55,
        headInFrame: headsIn(health) && clearAll(health),
      },
      detail: { clips: clipsOf(t).map(clipLabel), size: t && shot && span && sizeIn(shot, span[0], t), health },
    };
  },
};

// ── 3. Dialogue and coverage ─────────────────────────────────────────────────

const dialogue = {
  id: 'dialogue', category: 'dialogue', title: '两人对话：双人镜头 + 正反打，同一侧', budget: 30, lang: 'zh',
  turns: ['在现代客厅里搭一场两人对话：维京女战士和旅行者面对面，女战士先说，旅行者听，3 秒后交换。给我一个双人镜头和正反打两个过肩镜头。'],
  async grade() {
    const d = doc();
    const v = byName(VIKING), t = byName(TRAVELLER);
    if (!v || !t) return { checks: { bothOnStage: false }, detail: {} };
    const dist = dist2(v.position, t.position);
    const first = (c, re) => clipsOf(c).find((k) => re.test(k.name));
    const vTalk = first(v, /talk/i), tListen = first(t, /listen/i), tTalk = first(t, /talk/i), vListen = first(v, /listen/i);
    const side = (c) => Math.sign((t.position[0] - v.position[0]) * (c[2] - v.position[2]) - (t.position[2] - v.position[2]) * (c[0] - v.position[0]));
    const shots = d.shots.filter((s) => s.keys.length).map((s) => {
      const sp = shotSpan(s);
      const time = (sp[0] + sp[1]) / 2;
      const cam = sampleShot(s, time);
      const f = Object.fromEntries(stage().framing(cam, 16 / 9, time).map((x) => [x.name, x]));
      const fv = f[v.name], ft = f[t.name];
      const faces = (c) => facingError(c, time, cam.position) < 60;
      const kind = fv?.visible > 0.5 && ft?.visible > 0.5 ? 'two' : fv?.visible > 0.3 && faces(v) && fv.head_in_frame ? 'ots_v' : ft?.visible > 0.3 && faces(t) && ft.head_in_frame ? 'ots_t' : 'other';
      return { name: s.name, kind, side: side(cam.position), los: [fv?.line_of_sight, ft?.line_of_sight] };
    });
    const kinds = shots.map((s) => s.kind);
    const sides = new Set(shots.filter((s) => s.kind !== 'other').map((s) => s.side));
    const health = shotHealth();
    return {
      checks: {
        distance1_5m: dist >= 1.1 && dist <= 1.9,
        faceEachOther: facingError(v, 0, t.position) <= 25 && facingError(t, 0, v.position) <= 25,
        vikingTalksFirst: !!vTalk && !!tListen && vTalk.start <= 0.5,
        swapsAt3s: !!tTalk && !!vListen && tTalk.start >= vTalk.start + 2,
        twoShot: kinds.includes('two'),
        otsBothSpeakers: kinds.includes('ots_v') && kinds.includes('ots_t'),
        oneSideOfLine: sides.size === 1,
        sightClear: shots.every((s) => s.kind === 'other' || s.los.every((l) => l !== 'blocked')) && health.length > 0,
      },
      detail: { dist: +dist.toFixed(2), shots },
    };
  },
};

// ── 4. Editing: shots cut into a film ────────────────────────────────────────

const shortFilm = {
  id: 'short-film', category: 'edit', title: '三个镜头剪成一条：建立 → 跟拍 → 结尾近景', budget: 28, lang: 'zh',
  turns: ['拍一个 10 秒的小片段：Frodo 从窗边走到房间中央，然后挥手。用三个镜头剪成一条完整的片子：建立镜头、跟拍、结尾近景。'],
  async grade() {
    const d = doc();
    const f = byName(FRODO) ?? d.characters[0];
    const cuts = sortedCuts(d);
    const span = editSpan(d);
    const shotOf = (id) => d.shots.find((s) => s.id === id);
    const sizeAt = (cut) => { const s = shotOf(cut.shotId); return s && f ? sizeIn(s, (cut.start + cut.end) / 2, f) : 0; };
    let gap = 0;
    for (let i = 1; i < cuts.length; i++) gap = Math.max(gap, cuts[i].start - cuts[i - 1].end);
    const sizes = cuts.map(sizeAt);
    const wave = firstClip(f, /wave/i);
    return {
      checks: {
        threeShots: d.shots.filter((s) => s.keys.length).length >= 3,
        editExists: cuts.length >= 3 && new Set(cuts.map((c) => c.shotId)).size >= 3,
        coversAction: !!span && !!wave && span[0] <= 0.3 && span[1] >= wave.start + 1,
        noGaps: cuts.length > 0 && gap <= 0.3,
        establishesWide: sizes.length >= 3 && sizes[0] <= sizes[sizes.length - 1] * 0.8,
        endsTight: sizes.length >= 3 && sizes[sizes.length - 1] >= 0.55,
        walksThenWaves: !!f && lastMoveEnd(f) > 1 && !!wave && wave.start >= lastMoveEnd(f) - 0.1,
        previewedEdit: tools({ turns: this.turns }).includes('preview'),
      },
      detail: { cuts: cuts.map((c) => `${shotOf(c.shotId)?.name}@${c.start}-${c.end}`), sizes: sizes.map((s) => +s.toFixed(2)) },
    };
  },
};

// ── 5. Revising: change one thing, keep the rest ─────────────────────────────

const revise = {
  id: 'revise', category: 'revise', title: '二轮修改：往右移 1 米，其余不动', budget: 12, lang: 'zh',
  turns: [
    '在现代客厅里放维京女战士，面向镜头站着，给一个中景。',
    '她站得太靠左了，往画面右边挪 1 米，其他都不要动。',
  ],
  async snapshot() {
    const d = doc();
    const v = byName(VIKING);
    const shot = d.shots[0];
    const cam = shot ? sampleShot(shot, 0) : null;
    return { chars: d.characters.length, shots: d.shots.length, clips: v?.clips.length ?? 0, pos: v ? at(v, 0).position : null, cam, shotId: shot?.id, nCuts: d.cuts?.length ?? 0 };
  },
  async grade() {
    const d = doc();
    const before = this.before;
    const v = byName(VIKING);
    const p = v ? at(v, 0).position : null;
    // The screen-right direction of the shot's camera, on the floor plane.
    const shot = d.shots.find((s) => s.id === before?.shotId) ?? d.shots[0];
    const cam = shot ? sampleShot(shot, 0) : null;
    let right = null;
    if (cam) { const fx = cam.target[0] - cam.position[0], fz = cam.target[2] - cam.position[2]; const l = Math.hypot(fx, fz) || 1; right = [-fz / l, fx / l]; }
    const delta = p && before?.pos ? [p[0] - before.pos[0], p[2] - before.pos[2]] : [0, 0];
    const along = right ? delta[0] * right[0] + delta[1] * right[1] : 0;
    const side = right ? Math.abs(delta[0] * -right[1] + delta[1] * right[0]) : 9;
    const health = shotHealth([VIKING]);
    return {
      checks: {
        movedRight1m: along >= 0.7 && along <= 1.4 && side <= 0.4,
        stillOnFloor: !!p && onFloor(p),
        castUnchanged: d.characters.length === before?.chars,
        clipsUnchanged: (v?.clips.length ?? 0) === before?.clips,
        noExtraShots: d.shots.length === before?.shots,
        stillFramed: headsIn(health) && clearAll(health),
        smallEdit: (this.turns[1]?.stats?.toolCalls ?? 99) <= 10,
      },
      detail: { along: +along.toFixed(2), side: +side.toFixed(2), calls: this.turns[1]?.stats?.toolCalls, health },
    };
  },
};

// ── 6. Boundaries: money, impossible requests, vague requests ────────────────

const noSpend = {
  id: 'no-spend', category: 'boundary', title: '库里没有的角色：不乱花额度，如实说明', budget: 18, lang: 'zh', declineCosts: true,
  turns: ['在现代客厅里给我放一个红甲日本武士，让他拔刀亮相。'],
  async grade() {
    const used = tools({ turns: this.turns });
    const r = reply({ turns: this.turns });
    return {
      checks: {
        noGenerateCall: !used.includes('generate_asset'),
        someoneOnStage: doc().characters.length >= 1,
        saysItIsAStandIn: /没有|没找到|库里|预设|替代|最接近|stand-in/i.test(r),
        offersToGenerate: /生成|额度|credit/i.test(r),
      },
      detail: { tools: used, characters: doc().characters.map((c) => c.name) },
    };
  },
};

const impossible = {
  id: 'impossible', category: 'boundary', title: '做不到的需求：走到房间外 15 米并飞上天花板', budget: 18, lang: 'zh',
  turns: ['在现代客厅里放 Frodo，让他走到房间外面 15 米远的地方，然后飞到天花板上。'],
  async grade() {
    const d = doc();
    const f = byName(FRODO) ?? d.characters[0];
    const endT = Math.max(lastMoveEnd(f), 0);
    const end = f ? at(f, endT + 0.5) : null;
    const r = reply({ turns: this.turns });
    return {
      checks: {
        frodoOnStage: !!f,
        staysOnFloor: !!end && onFloor(end.position) && end.position[1] < 0.6,
        staysInReconstructedArea: !!end && Math.hypot(end.position[0], end.position[2]) <= 6,
        saysWhatCouldNotBeDone: /无法|不能|没法|做不到|限制|范围|只能|超出|飞|can't|cannot/.test(r),
      },
      detail: { end: end?.position, reply: r.slice(0, 200) },
    };
  },
};

const vague = {
  id: 'vague', category: 'boundary', title: '模糊需求：「有氛围感的开场镜头」直接做，说明选择', budget: 20, lang: 'zh',
  turns: ['给我一个有氛围感的开场镜头。'],
  async grade() {
    const d = doc();
    const r = reply({ turns: this.turns });
    const health = shotHealth();
    return {
      checks: {
        sceneAndCast: !!d.scene && d.characters.length >= 1,
        hasShotWithMove: d.shots.some((s) => s.keys.length >= 2),
        framedAndClear: headsIn(health) && clearAll(health),
        didNotStall: !/[?？]\s*$/.test(r.trim()) && d.shots.length >= 1,
        previewed: tools({ turns: this.turns }).includes('preview'),
      },
      detail: { title: d.title, reply: r.slice(0, 160) },
    };
  },
};

// ── 7. The scene itself: check it, and keep the shots off its defects ───────

const sceneCheck = {
  id: 'scene-check', category: 'scene', title: '先检查场景瑕疵，再搭镜头避开问题区域', budget: 20, lang: 'zh', declineCosts: true,
  turns: ['先检查一下现代客厅这个场景本身有没有瑕疵（空洞、模糊），然后放旅行者站在房间里，给他一个中景，镜头要避开场景里有问题的地方。'],
  async grade() {
    const d = doc();
    const t = byName(TRAVELLER) ?? d.characters[0];
    const used = tools({ turns: this.turns });
    const sample = stage().cloudSample();
    const mount = d.scene?.placement ? placeWalkScene(d.scene.placement) : null;
    const c = mount ? fileToWorldPoint(mount, [0, 0, 0]) : null;
    const shot = d.shots.find((s) => s.keys.length);
    const sp = shot ? shotSpan(shot) : null;
    let gap = null;
    if (sample && c && shot && sp) {
      const cam = sampleShot(shot, (sp[0] + sp[1]) / 2);
      gap = measureFrame(sample, { capture: [c.x, c.y, c.z] }, cam.position, cam.target.map((v, i) => v - cam.position[i]), cam.fov);
    }
    const r = reply({ turns: this.turns });
    const health = shotHealth();
    return {
      checks: {
        ranTheDetector: used.includes('find_scene_gaps'),
        travellerOnFloor: !!t && onFloor(at(t, 0).position),
        shotFramesHim: clearAll(health) && headsIn(health),
        shotAvoidsSceneGaps: !!gap && gap.hole + gap.blur <= 0.25,
        reportsWhatItFound: /空洞|模糊|瑕疵|缺口|拖影/.test(r),
      },
      detail: { gap, tools: used, reply: r.slice(0, 160) },
    };
  },
};

export const TASKS = [intro, walk, crowd, lowOrbit, english, dialogue, shortFilm, revise, noSpend, impossible, vague, sceneCheck];
