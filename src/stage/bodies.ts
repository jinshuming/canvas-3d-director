/**
 * The people standing in a scene, as a walk sees them: footprints in metres. The scene's own furniture is
 * the collider's.
 *
 * Copied from PINOC (src/components/screens/jst2Gallery/obstacles.ts: `NpcBodies`, `pushOutOfBodies`).
 */

/** A person's footprint: a circle in metres. */
export interface Body {
  id: string;
  x: number;
  z: number;
  radius: number;
}

/** The people's bodies, filled in by the host, read by the walk's probe. */
export class NpcBodies {
  private readonly bodies = new Map<string, Body>();

  set(id: string, x: number, z: number, radius: number): void {
    this.bodies.set(id, { id, x, z, radius });
  }

  clear(): void {
    this.bodies.clear();
  }

  list(): IterableIterator<Body> {
    return this.bodies.values();
  }

  /** The body nearest to (x, z), and how far (metres) its edge is. */
  nearest(x: number, z: number): { body: Body; distance: number } | null {
    let best: { body: Body; distance: number } | null = null;
    for (const body of this.bodies.values()) {
      const d = Math.hypot(x - body.x, z - body.z) - body.radius;
      if (!best || d < best.distance) best = { body, distance: d };
    }
    return best;
  }
}

/**
 * Moves (x, z) out of the people's footprints, a body `radius` clear of each, along the line from the person's centre, or
 * answers null when it is already clear. A step that ends inside one ends on its edge, so the walker slides round people at
 * the speed of the part of its step that runs along them (metres, like the footprints). Where two footprints overlap there is
 * no clear point: the result is then on the edge of one of them, which is as good as the walker can do.
 */
export function pushOutOfBodies(bodies: NpcBodies, x: number, z: number, radius: number): { x: number; z: number } | null {
  let px = x;
  let pz = z;
  let moved = false;
  // A few passes: leaving one person's edge can be the inside of the next person's.
  for (let pass = 0; pass < 4; pass++) {
    let again = false;
    for (const b of bodies.list()) {
      const reach = b.radius + radius;
      const dx = px - b.x;
      const dz = pz - b.z;
      const d = Math.hypot(dx, dz);
      if (d >= reach) continue;
      // Dead centre has no direction: leave the way the walker came, or along +x.
      const ux = d > 1e-6 ? dx / d : 1;
      const uz = d > 1e-6 ? dz / d : 0;
      px = b.x + ux * reach;
      pz = b.z + uz * reach;
      moved = true;
      again = true;
    }
    if (!again) break;
  }
  return moved ? { x: px, z: pz } : null;
}
