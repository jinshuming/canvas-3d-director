/**
 * The blockout in 3D (three.js): the room shell as outlines, every object's
 * parts as solids in its semantic colour, the capture point and the way the
 * panorama faces. Click an object to select it.
 */
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { forwardOf } from '../core/frame.ts';
import type { CameraPose } from '../core/frame.ts';
import { classColor, objectSolids } from '../core/geometry.ts';
import type { Layout } from '../core/types.ts';

export function Viewport({ layout, capture, selected, onSelect }: { layout: Layout; capture: CameraPose | null; selected: string | null; onSelect: (id: string | null) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const ctx = useRef<{ renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; controls: OrbitControls; group: THREE.Group } | null>(null);

  useEffect(() => {
    const el = host.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#eef0f3');
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a8a, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(4, 8, 6);
    scene.add(sun);
    const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 500);
    camera.position.set(6, 7, 9);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0.8, 0);
    const group = new THREE.Group();
    scene.add(group);
    ctx.current = { renderer, scene, camera, controls, group };
    const resize = () => { const w = el.clientWidth, h = el.clientHeight; renderer.setSize(w, h, false); renderer.domElement.style.width = '100%'; renderer.domElement.style.height = '100%'; camera.aspect = w / Math.max(1, h); camera.updateProjectionMatrix(); };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();
    let raf = 0;
    const tick = () => { controls.update(); renderer.render(scene, camera); raf = requestAnimationFrame(tick); };
    tick();
    const ray = new THREE.Raycaster();
    let down: [number, number] | null = null;
    const onDown = (e: PointerEvent) => { down = [e.clientX, e.clientY]; };
    const onUp = (e: PointerEvent) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
      const r = renderer.domElement.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
      const hit = ray.intersectObjects(group.children, true).find((h) => h.object.userData.id);
      onSelectRef.current(hit ? String(hit.object.userData.id) : null);
    };
    renderer.domElement.addEventListener('pointerdown', onDown);
    renderer.domElement.addEventListener('pointerup', onUp);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); controls.dispose(); renderer.dispose(); el.removeChild(renderer.domElement); };
  }, []);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    const c = ctx.current;
    if (!c) return;
    const g = c.group;
    for (const ch of [...g.children]) { g.remove(ch); ch.traverse((o) => { const m = o as THREE.Mesh; m.geometry?.dispose(); (m.material as THREE.Material | undefined)?.dispose?.(); }); }
    const extent = layout.room ? Math.max(layout.room.width, layout.room.depth) : Math.min(layout.ground.size, 40);
    // Floor / ground
    const fw = layout.room ? layout.room.width : extent, fd = layout.room ? layout.room.depth : extent;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(fw, fd), new THREE.MeshStandardMaterial({ color: layout.room ? 0xc9bfb2 : 0xb6c49a }));
    floor.rotation.x = -Math.PI / 2;
    g.add(floor);
    g.add(new THREE.GridHelper(Math.ceil(Math.max(fw, fd)), Math.ceil(Math.max(fw, fd)), 0x999999, 0xbbbbbb));
    if (layout.room) {
      const r = layout.room;
      const box = new THREE.BoxGeometry(r.width, r.height, r.depth);
      box.translate(0, r.height / 2, 0);
      g.add(new THREE.LineSegments(new THREE.EdgesGeometry(box), new THREE.LineBasicMaterial({ color: 0x555555 })));
      for (const o of r.openings) {
        const along = o.wall === 'north' || o.wall === 'south';
        const geo = new THREE.PlaneGeometry(o.width, o.height);
        const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: o.kind === 'window' ? 0x7fb7ff : 0xa07850, side: THREE.DoubleSide, transparent: true, opacity: 0.6 }));
        const y = o.sill + o.height / 2;
        if (along) m.position.set(o.offset, y, o.wall === 'north' ? -r.depth / 2 + 0.01 : r.depth / 2 - 0.01);
        else { m.position.set(o.wall === 'east' ? r.width / 2 - 0.01 : -r.width / 2 + 0.01, y, o.offset); m.rotation.y = Math.PI / 2; }
        g.add(m);
      }
    }
    for (const s of objectSolids(layout)) {
      const o = layout.objects[s.obj]!;
      const p = s.part;
      const geo = p.kind === 'box' ? new THREE.BoxGeometry(p.s[0], p.s[1], p.s[2]) : p.kind === 'cyl' ? new THREE.CylinderGeometry(p.r, p.r, p.h, 20) : new THREE.ConeGeometry(p.r, p.h, 20);
      if (p.kind === 'cone') geo.translate(0, p.h / 2, 0);
      const [r, gg, b] = classColor(s.cls);
      const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(r / 255, gg / 255, b / 255), emissive: o.id === selected ? new THREE.Color(0.35, 0.25, 0) : new THREE.Color(0, 0, 0) });
      const mesh = new THREE.Mesh(geo, mat);
      // Local part offset, rotated by the object's yaw (front +Z → (sin, 0, cos)).
      const yaw = (o.yaw * Math.PI) / 180;
      const lx = p.c[0], lz = p.c[2];
      mesh.position.set(o.position[0] + Math.cos(yaw) * lx + Math.sin(yaw) * lz, o.position[1] + p.c[1], o.position[2] - Math.sin(yaw) * lx + Math.cos(yaw) * lz);
      mesh.rotation.y = yaw;
      mesh.userData.id = o.id;
      g.add(mesh);
    }
    if (capture) {
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.12, 16, 12), new THREE.MeshBasicMaterial({ color: 0xff3366 }));
      ball.position.set(...capture.position);
      g.add(ball);
      const f = forwardOf(capture.yaw, 0);
      g.add(new THREE.ArrowHelper(new THREE.Vector3(...f), new THREE.Vector3(...capture.position), 1.0, 0xff3366, 0.25, 0.15));
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, capture.position[1], 6), new THREE.MeshBasicMaterial({ color: 0xff3366 }));
      pole.position.set(capture.position[0], capture.position[1] / 2, capture.position[2]);
      g.add(pole);
    }
  }, [layout, capture, selected]);

  return <div ref={host} className="viewport" />;
}
