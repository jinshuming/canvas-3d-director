// Programmatic checks on the stage an agent built. Each returns [name, pass, detail].
const d = () => window.__director.host.getDoc();
const r = () => window.__stage;

const ang = (a) => ((((a + 180) % 360) + 360) % 360) - 180;
const yawToward = (a, b) => (Math.atan2(-(b[0] - a[0]), -(b[2] - a[2])) * 180) / Math.PI;
const byName = (re) => d().characters.find((c) => re.test(c.name) || re.test(c.url));

/** Every shot, at its start, middle and end: is everyone it should see in frame, with a clear view? */
async function shotHealth(names) {
  const { sampleShot, shotSpan } = await import('/src/stage/camera.ts');
  const out = [];
  for (const s of d().shots) {
    const span = shotSpan(s);
    if (!span) { out.push({ shot: s.name, keys: 0 }); continue; }
    const times = [span[0], (span[0] + span[1]) / 2, span[1]];
    let clear = 0, framed = 0, total = 0;
    for (const t of times) {
      for (const f of r().framing(sampleShot(s, t), 16 / 9, t)) {
        if (names && !names.some((n) => n.test(f.name))) continue;
        total++;
        if (f.line_of_sight === 'clear') clear++;
        if (f.head_in_frame && f.visible > 0.2) framed++;
      }
    }
    out.push({ shot: s.name, keys: s.keys.length, span, clear: `${clear}/${total}`, headInFrame: `${framed}/${total}` });
  }
  return out;
}

function facing(c, target) {
  return Math.abs(ang(c.yaw - yawToward(c.position, target)));
}

window.__grade = { d, byName, shotHealth, facing, yawToward, ang };
