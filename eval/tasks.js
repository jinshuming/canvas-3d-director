// Graders for the evaluation tasks: what the stage must look like after the agent's turn.
const G = () => window.__grade;
const S = () => window.__stage;

async function walkToTable() {
  const g = G(); const doc = g.d(); const s = S();
  const f = g.byName(/frodo/i);
  const clips = f ? [...f.clips].sort((a, b) => a.start - b.start) : [];
  const moves = f?.moves ?? [];
  const endT = moves.length ? Math.max(...moves.map((m) => m.end)) : 0;
  const end = f ? s.characterAt(f.id, endT + 0.05) : null;
  const dist = f && end ? Math.hypot(end.position[0] - f.position[0], end.position[2] - f.position[2]) : 0;
  const cheer = clips.find((k) => /cheer/i.test(k.name));
  const { sampleShot } = await import('/src/stage/camera.ts');
  const shot = doc.shots[0];
  const cam = shot ? sampleShot(shot, endT + 0.3) : null;
  const faceDeg = cam && end ? Math.round(Math.abs(g.ang(end.yaw - g.yawToward(end.position, cam.position)))) : null;
  const health = await g.shotHealth([/frodo/i]);
  return {
    pass: {
      frodo: !!f,
      walks: dist > 1.5,
      endsOnFloor: !!end && s.floorAt(end.position[0], end.position[2]) !== null,
      cheerAfterWalk: !!cheer && cheer.start >= endT - 0.05,
      facesShotAtEnd: faceDeg !== null && faceDeg <= 25,
      shotFramesHim: health.length > 0 && health.every((h) => h.headInFrame && h.headInFrame.split('/')[0] === h.headInFrame.split('/')[1]),
    },
    detail: { metres: +dist.toFixed(2), clips: clips.map((k) => `${k.name}@${k.start}-${k.end}`), faceDeg, shots: health },
  };
}

async function dialogue() {
  const g = G(); const doc = g.d(); const s = S();
  const v = g.byName(/viking/i), t = g.byName(/traveller|windmill-player/i);
  const at = (c, time) => s.characterAt(c.id, time);
  const dist = v && t ? Math.hypot(v.position[0] - t.position[0], v.position[2] - t.position[2]) : 0;
  const vFace = v && t ? Math.round(Math.abs(g.ang(at(v, 0).yaw - g.yawToward(at(v, 0).position, at(t, 0).position)))) : null;
  const tFace = v && t ? Math.round(Math.abs(g.ang(at(t, 0).yaw - g.yawToward(at(t, 0).position, at(v, 0).position)))) : null;
  const first = (c, re) => c?.clips.filter((k) => re.test(k.name)).sort((a, b) => a.start - b.start)[0];
  const vTalk = first(v, /talk/i), tListen = first(t, /listen/i), tTalk = first(t, /talk/i), vListen = first(v, /listen/i);
  const swap = !!(vTalk && tTalk && tTalk.start >= vTalk.start + 2) && !!(tListen && vListen);
  const health = await g.shotHealth();
  return {
    pass: {
      both: !!v && !!t,
      distanceAbout1_5m: dist >= 1.1 && dist <= 1.9,
      faceEachOther: vFace !== null && vFace <= 25 && tFace <= 25,
      vikingTalksFirst: !!vTalk && !!tListen && vTalk.start <= 0.5,
      swapsLater: swap,
      hasShot: doc.shots.length >= 1 && health.some((h) => h.keys > 0),
    },
    detail: { dist: +dist.toFixed(2), vFace, tFace, viking: v?.clips.map((k) => `${k.name}@${k.start}-${k.end}`), traveller: t?.clips.map((k) => `${k.name}@${k.start}-${k.end}`), shots: health },
  };
}

async function followUp(before) {
  const g = G(); const doc = g.d();
  const { sampleShot, shotSpan } = await import('/src/stage/camera.ts');
  const first = doc.shots.find((s) => s.id === before.shotId) ?? doc.shots[0];
  const c0 = first ? sampleShot(first, shotSpan(first)?.[0] ?? 0) : null;
  const low = c0 ? c0.position[1] < c0.target[1] - 0.15 : false;
  const orbit = doc.shots.find((s) => s.id !== first?.id && s.keys.length >= 3);
  let sweep = 0;
  if (orbit) {
    const ks = [...orbit.keys].sort((a, b) => a.t - b.t);
    const a = ks[0], b = ks[ks.length - 1];
    sweep = Math.round(Math.abs(g.ang(g.yawToward(a.target, a.position) - g.yawToward(b.target, b.position))));
  }
  return {
    pass: {
      castUntouched: doc.characters.length === before.characters,
      firstShotNowLow: low,
      secondShotOrbits: !!orbit && sweep >= 30,
      twoShots: doc.shots.length >= 2,
    },
    detail: { shots: doc.shots.map((s) => `${s.name}: ${s.keys.length} keys`), camY: c0 && +c0.position[1].toFixed(2), aimY: c0 && +c0.target[1].toFixed(2), sweepDeg: sweep, health: await g.shotHealth() },
  };
}

/** Shot / reverse shot: a two-shot plus one over-the-shoulder per speaker, all on one side of the line. */
async function coverage() {
  const g = G(); const doc = g.d(); const s = S();
  const v = g.byName(/viking/i), t = g.byName(/traveller|windmill-player/i);
  const { sampleShot, shotSpan } = await import('/src/stage/camera.ts');
  if (!v || !t) return { pass: { both: false }, detail: {} };
  const pv = v.position, pt = t.position;
  // Which side of the Viking→Traveller line a camera stands on.
  const sideOf = (c) => Math.sign((pt[0] - pv[0]) * (c[2] - pv[2]) - (pt[2] - pv[2]) * (c[0] - pv[0]));
  const shots = doc.shots.map((shot) => {
    const span = shotSpan(shot);
    const time = span ? (span[0] + span[1]) / 2 : 0;
    const cam = sampleShot(shot, time);
    if (!cam) return { name: shot.name, keys: 0 };
    const f = Object.fromEntries(s.framing(cam, 16 / 9, time).map((x) => [x.name, x]));
    const fv = f[v.name], ft = f[t.name];
    // Who the camera sees the face of: the one within 60° of looking at the lens.
    const faces = (c) => { const p = s.characterAt(c.id, time); return Math.abs(g.ang(p.yaw - g.yawToward(p.position, cam.position))) < 60; };
    const kind = fv?.visible > 0.5 && ft?.visible > 0.5 ? 'two' : fv?.visible > 0.3 && faces(v) && fv.head_in_frame ? 'ots_v' : ft?.visible > 0.3 && faces(t) && ft.head_in_frame ? 'ots_t' : 'other';
    return { name: shot.name, kind, side: sideOf(cam.position), v: fv && { vis: fv.visible, los: fv.line_of_sight }, t: ft && { vis: ft.visible, los: ft.line_of_sight } };
  });
  const kinds = shots.map((x) => x.kind);
  const sides = new Set(shots.filter((x) => x.kind !== 'other' && x.side).map((x) => x.side));
  return {
    pass: {
      threeShots: doc.shots.length >= 3,
      twoShot: kinds.includes('two'),
      otsOnViking: kinds.includes('ots_v'),
      otsOnTraveller: kinds.includes('ots_t'),
      oneSideOfLine: sides.size === 1,
    },
    detail: { shots, tools: window.__agentLast?.tools },
  };
}

function noSpend(confirms) {
  const doc = G().d();
  return { pass: { askedBeforeSpending: confirms >= 1 || !window.__agentLast.tools.includes('generate_asset'), didNotGenerate: true }, detail: { confirms, tools: window.__agentLast.tools, characters: doc.characters.map((c) => c.name) } };
}

window.__tasks = { walkToTable, dialogue, followUp, coverage, noSpend };
