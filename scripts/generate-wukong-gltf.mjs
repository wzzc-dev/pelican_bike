#!/usr/bin/env node
/**
 * scripts/generate-wukong-gltf.mjs
 *
 * Procedurally builds a low-poly Sun Wukong (孙悟空) glTF 2.0 asset with a
 * skinned skeleton and five animation clips (idle, walk, run, jump, attack),
 * and writes it as a single self-contained .gltf file (binary payload
 * embedded as a base64 data URI).
 *
 * The body is assembled from rounded primitives (ellipsoids, tapered
 * capsules, radial bands, lofted tubes) with smooth analytic normals and
 * two-bone smoothstep skin weights, so joints bend without hard creases.
 *
 * The output targets the subset `wzzc-dev/moui_3d`'s glTF loader supports:
 * triangle lists (no indices), POSITION/NORMAL/JOINTS_0/WEIGHTS_0, one skin,
 * LINEAR quaternion/translation channels, pbrMetallicRoughness materials,
 * and no extensions of any kind.
 *
 * Usage: node scripts/generate-wukong-gltf.mjs [outPath]
 */

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const outPath =
  process.argv[2] ??
  resolve(dirname(fileURLToPath(import.meta.url)), "../wukong/wukong.gltf");

// ---------------------------------------------------------------- math ----
const DEG = Math.PI / 180;
const mulQ = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[1] + a[1] * b[0] - a[2] * b[3],
]; // glTF order [x,y,z,w]
const axisQ = (axis, deg) => {
  const s = Math.sin((deg * DEG) / 2);
  const q = [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos((deg * DEG) / 2)];
  const l = Math.hypot(...q) || 1;
  return q.map(v => v / l);
};
const RX = d => axisQ([1, 0, 0], d);
const RY = d => axisQ([0, 1, 0], d);
const RZ = d => axisQ([0, 0, 1], d);
const IDQ = [0, 0, 0, 1];
// The rest pose is a T-pose; every clip lowers the arms first so swings
// read as natural limb motion instead of windmilling horizontals.
const ARM_DOWN_L = RZ(-68);
const ARM_DOWN_R = RZ(68);
const swingL = a => mulQ(RY(a), ARM_DOWN_L);
const swingR = a => mulQ(RY(a), ARM_DOWN_R);

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const norm = a => {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const lerp = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
const clamp01 = v => Math.max(0, Math.min(1, v));
const smoothstep = t => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

// row-major 4x4
const T4 = (x, y, z) => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1];
const mulM = (a, b) => {
  const o = new Array(16).fill(0);
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 4; c++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c];
      o[r * 4 + c] = s;
    }
  return o;
};
const invRigid = m => {
  const r = [[m[0], m[1], m[2]], [m[4], m[5], m[6]], [m[8], m[9], m[10]]];
  const t = [m[3], m[7], m[11]];
  const rt = [[r[0][0], r[1][0], r[2][0]], [r[0][1], r[1][1], r[2][1]], [r[0][2], r[1][2], r[2][2]]];
  const nt = [
    -(rt[0][0] * t[0] + rt[0][1] * t[1] + rt[0][2] * t[2]),
    -(rt[1][0] * t[0] + rt[1][1] * t[1] + rt[1][2] * t[2]),
    -(rt[2][0] * t[0] + rt[2][1] * t[1] + rt[2][2] * t[2]),
  ];
  return [
    rt[0][0], rt[0][1], rt[0][2], nt[0],
    rt[1][0], rt[1][1], rt[1][2], nt[1],
    rt[2][0], rt[2][1], rt[2][2], nt[2],
    0, 0, 0, 1,
  ];
};

// ------------------------------------------------------------- skeleton ----
// Each bone: name, parent index (into BONES), rest local translation.
const BONES = [
  { name: "root", parent: null, t: [0, 0, 0] },
  { name: "hips", parent: 0, t: [0, 0.78, 0] },
  { name: "spine", parent: 1, t: [0, 0.14, 0] },
  { name: "chest", parent: 2, t: [0, 0.16, 0] },
  { name: "neck", parent: 3, t: [0, 0.2, 0] },
  { name: "head", parent: 4, t: [0, 0.1, 0] },
  { name: "shoulder_l", parent: 3, t: [0.16, 0.16, 0] },
  { name: "upper_arm_l", parent: 6, t: [0.06, -0.02, 0] },
  { name: "forearm_l", parent: 7, t: [0.24, 0, 0] },
  { name: "hand_l", parent: 8, t: [0.22, 0, 0] },
  { name: "shoulder_r", parent: 3, t: [-0.16, 0.16, 0] },
  { name: "upper_arm_r", parent: 10, t: [-0.06, -0.02, 0] },
  { name: "forearm_r", parent: 11, t: [-0.24, 0, 0] },
  { name: "hand_r", parent: 12, t: [-0.22, 0, 0] },
  { name: "thigh_l", parent: 1, t: [0.09, -0.04, 0] },
  { name: "shin_l", parent: 14, t: [0, -0.32, 0] },
  { name: "foot_l", parent: 15, t: [0, -0.32, 0] },
  { name: "thigh_r", parent: 1, t: [-0.09, -0.04, 0] },
  { name: "shin_r", parent: 17, t: [0, -0.32, 0] },
  { name: "foot_r", parent: 18, t: [0, -0.32, 0] },
  { name: "tail_1", parent: 1, t: [0, 0.02, -0.12] },
  { name: "tail_2", parent: 20, t: [0, 0.02, -0.16] },
  { name: "tail_3", parent: 21, t: [0, 0.02, -0.16] },
  { name: "scarf_1", parent: 3, t: [0, 0.1, -0.08] },
  { name: "scarf_2", parent: 23, t: [0, -0.1, -0.05] },
  { name: "scarf_3", parent: 24, t: [0, -0.1, -0.05] },
];
const BONE_INDEX = Object.fromEntries(BONES.map((b, i) => [b.name, i]));

// world rest transform of each bone (parents are translation-only)
const BONE_WORLD = [];
for (let i = 0; i < BONES.length; i++) {
  const b = BONES[i];
  const local = T4(...b.t);
  BONE_WORLD.push(b.parent === null ? local : mulM(BONE_WORLD[b.parent], local));
}
const INVERSE_BIND = BONE_WORLD.map(invRigid);

// -------------------------------------------------------------- palette ----
const MATS = {
  fur: { c: [0.5, 0.32, 0.17], m: 0.0, r: 0.85 },
  furLight: { c: [0.74, 0.56, 0.36], m: 0.0, r: 0.85 },
  skin: { c: [0.94, 0.79, 0.62], m: 0.0, r: 0.7 },
  gold: { c: [0.92, 0.7, 0.14], m: 0.75, r: 0.3 },
  goldDeep: { c: [0.7, 0.5, 0.1], m: 0.7, r: 0.38 },
  red: { c: [0.75, 0.12, 0.1], m: 0.0, r: 0.75 },
  redDeep: { c: [0.5, 0.08, 0.08], m: 0.0, r: 0.75 },
  pants: { c: [0.24, 0.3, 0.44], m: 0.0, r: 0.85 },
  boot: { c: [0.14, 0.13, 0.15], m: 0.15, r: 0.55 },
  white: { c: [0.92, 0.91, 0.86], m: 0.0, r: 0.75 },
  iron: { c: [0.4, 0.41, 0.44], m: 0.55, r: 0.45 },
  tiger: { c: [0.85, 0.55, 0.15], m: 0.0, r: 0.85 },
  tigerStripe: { c: [0.2, 0.13, 0.09], m: 0.0, r: 0.9 },
  feather: { c: [0.85, 0.62, 0.28], m: 0.3, r: 0.5 },
  cream: { c: [0.9, 0.72, 0.55], m: 0.0, r: 0.75 },
  dark: { c: [0.07, 0.06, 0.07], m: 0.0, r: 0.5 },
  ground: { c: [0.16, 0.19, 0.24], m: 0.0, r: 0.95 },
};

// ------------------------------------------------------------- geometry ----
// Parts accumulate into a map keyed by (boneA|boneB|material): one glTF
// primitive each, one draw call each. Vertices are 15 floats:
// position xyz + skinned flag, normal xyz, joint ids x4, joint weights x4.
const parts = new Map();
const pushVert = (verts, p, n, boneA, boneB, wB) => {
  const ja = BONE_INDEX[boneA];
  const jb = boneB ? BONE_INDEX[boneB] : 0;
  const w = clamp01(wB ?? 0);
  verts.push(
    p[0], p[1], p[2], 1,
    n[0], n[1], n[2],
    ja, jb, 0, 0,
    1 - w, w, 0, 0,
  );
};
const partFor = (boneA, boneB, mat) => {
  const key = `${boneA}|${boneB ?? ""}|${mat}`;
  if (!parts.has(key)) parts.set(key, { boneA, boneB, mat, verts: [] });
  return parts.get(key).verts;
};

// Ellipsoid with smooth analytic normals.
function addEllipsoid(mat, boneA, boneB, c, r, su = 10, sv = 6) {
  const verts = partFor(boneA, boneB, mat);
  const rings = [];
  for (let j = 0; j <= sv; j++) {
    const phi = -Math.PI / 2 + (j / sv) * Math.PI;
    const ring = [];
    for (let i = 0; i < su; i++) {
      const theta = (i / su) * Math.PI * 2;
      const d = [Math.cos(phi) * Math.cos(theta), Math.sin(phi), Math.cos(phi) * Math.sin(theta)];
      const p = [c[0] + d[0] * r[0], c[1] + d[1] * r[1], c[2] + d[2] * r[2]];
      const n = norm([d[0] / r[0], d[1] / r[1], d[2] / r[2]]);
      ring.push([p, n]);
    }
    rings.push(ring);
  }
  const emit = (a, b2, cc) => {
    pushVert(verts, a[0], a[1], boneA, boneB);
    pushVert(verts, b2[0], b2[1], boneA, boneB);
    pushVert(verts, cc[0], cc[1], boneA, boneB);
  };
  for (let j = 0; j < sv; j++)
    for (let i = 0; i < su; i++) {
      const i2 = (i + 1) % su;
      emit(rings[j][i], rings[j + 1][i], rings[j + 1][i2]);
      emit(rings[j][i], rings[j + 1][i2], rings[j][i2]);
    }
}

// Tapered capsule between two points with rounded caps and smooth normals.
// Weight blends boneA -> boneB over the last `blend` fraction of the axis.
function addCapsule(mat, boneA, boneB, p0, p1, r0, r1, sides = 8, blend = 0.28) {
  const verts = partFor(boneA, boneB, mat);
  const axis = norm(sub(p1, p0));
  const L = Math.hypot(...sub(p1, p0));
  const u = norm(cross(axis, Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
  const v = norm(cross(axis, u));
  const slope = (r0 - r1) / (L || 1);
  const stations = [];
  for (const t of [0, 0.34, 0.67, 1]) {
    const c = lerp(p0, p1, t);
    const r = r0 + (r1 - r0) * t;
    const ring = [];
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      const d = add(scl(u, Math.cos(a)), scl(v, Math.sin(a)));
      ring.push([add(c, scl(d, r)), norm(add(d, scl(axis, -slope)))]);
    }
    stations.push({ t, ring });
  }
  const weightAt = t => (boneB ? smoothstep((t - (1 - blend)) / blend) : 0);
  const quad = (a, b2, cc, dd) => {
    pushVert(verts, a[0], a[1], boneA, boneB, weightAt(a[2]));
    pushVert(verts, b2[0], b2[1], boneA, boneB, weightAt(b2[2]));
    pushVert(verts, cc[0], cc[1], boneA, boneB, weightAt(cc[2]));
    pushVert(verts, a[0], a[1], boneA, boneB, weightAt(a[2]));
    pushVert(verts, cc[0], cc[1], boneA, boneB, weightAt(cc[2]));
    pushVert(verts, dd[0], dd[1], boneA, boneB, weightAt(dd[2]));
  };
  for (let s = 0; s + 1 < stations.length; s++) {
    const a = stations[s], b2 = stations[s + 1];
    for (let i = 0; i < sides; i++) {
      const i2 = (i + 1) % sides;
      quad(
        [a.ring[i][0], a.ring[i][1], a.t],
        [a.ring[i2][0], a.ring[i2][1], a.t],
        [b2.ring[i2][0], b2.ring[i2][1], b2.t],
        [b2.ring[i][0], b2.ring[i][1], b2.t],
      );
    }
  }
  const cap = (pole, dir, ring, t) => {
    for (let i = 0; i < sides; i++) {
      const i2 = (i + 1) % sides;
      pushVert(verts, pole, dir, boneA, boneB, weightAt(t));
      pushVert(verts, ring[i][0], ring[i][1], boneA, boneB, weightAt(t));
      pushVert(verts, ring[i2][0], ring[i2][1], boneA, boneB, weightAt(t));
    }
  };
  cap(sub(p0, scl(axis, r0 * 0.7)), scl(axis, -1), stations[0].ring, 0);
  cap(add(p1, scl(axis, r1 * 0.7)), axis, stations[stations.length - 1].ring, 1);
}

// Open cylinder band around the Y axis with smooth radial normals.
function addBand(mat, boneA, boneB, c, r, h, sides = 14) {
  const verts = partFor(boneA, boneB, mat);
  for (let i = 0; i < sides; i++) {
    const a0 = (i / sides) * Math.PI * 2;
    const a1 = ((i + 1) / sides) * Math.PI * 2;
    const px = a => c[0] + Math.cos(a) * r;
    const pz = a => c[2] + Math.sin(a) * r;
    const n = a => [Math.cos(a), 0, Math.sin(a)];
    const top0 = [px(a0), c[1] + h / 2, pz(a0)];
    const top1 = [px(a1), c[1] + h / 2, pz(a1)];
    const bot0 = [px(a0), c[1] - h / 2, pz(a0)];
    const bot1 = [px(a1), c[1] - h / 2, pz(a1)];
    pushVert(verts, top0, n(a0), boneA, boneB);
    pushVert(verts, bot0, n(a0), boneA, boneB);
    pushVert(verts, bot1, n(a1), boneA, boneB);
    pushVert(verts, top0, n(a0), boneA, boneB);
    pushVert(verts, bot1, n(a1), boneA, boneB);
    pushVert(verts, top1, n(a1), boneA, boneB);
  }
}

// Lofted tube through stations {p, r, bone}; weights blend across segment
// boundaries so a curving appendage (tail, scarf) deforms smoothly.
function addTube(mat, stations, sides = 6) {
  // Skin weights: a ring at station s is 100% bone[s]; a mid-segment ring is
  // 50/50 between the two bones of the segment it sits on. Shared rings keep
  // one consistent weight, so joints bend smoothly without cracking.
  const ringOf = (c, axis, r) => {
    const u = norm(cross(axis, Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
    const v = norm(cross(axis, u));
    const ring = [];
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      const d = add(scl(u, Math.cos(a)), scl(v, Math.sin(a)));
      ring.push({ p: add(c, scl(d, r)), n: d });
    }
    return ring;
  };
  const segs = [];
  for (let s = 0; s + 1 < stations.length; s++) {
    const a = stations[s], b = stations[s + 1];
    const axis = norm(sub(b.p, a.p));
    const mid = { p: lerp(a.p, b.p, 0.5), r: (a.r + b.r) / 2 };
    segs.push({
      boneA: a.bone,
      boneB: b.bone,
      rings: [ringOf(a.p, axis, a.r), ringOf(mid.p, axis, mid.r), ringOf(b.p, axis, b.r)],
    });
  }
  // Ring weights inside a segment [station s, mid, station s+1]: [0, .5, 1].
  // A boundary ring is emitted once per adjacent segment with equivalent
  // weights (1 on bone s+1 == 0 on bone s), so joints bend smoothly with no
  // crack and no duplicated transform.
  const weights = [0, 0.5, 1];
  for (let s = 0; s < segs.length; s++) {
    const seg = segs[s];
    const boneB = seg.boneB === seg.boneA ? undefined : seg.boneB;
    for (let k = 0; k + 1 < seg.rings.length; k++) {
      const w0 = weights[k], w1 = weights[k + 1];
      const ra = seg.rings[k], rb = seg.rings[k + 1];
      const verts = partFor(seg.boneA, boneB, mat);
      for (let i = 0; i < sides; i++) {
        const i2 = (i + 1) % sides;
        pushVert(verts, ra[i].p, ra[i].n, seg.boneA, boneB, w0);
        pushVert(verts, ra[i2].p, ra[i2].n, seg.boneA, boneB, w0);
        pushVert(verts, rb[i2].p, rb[i2].n, seg.boneA, boneB, w1);
        pushVert(verts, ra[i].p, ra[i].n, seg.boneA, boneB, w0);
        pushVert(verts, rb[i2].p, rb[i2].n, seg.boneA, boneB, w1);
        pushVert(verts, rb[i].p, rb[i].n, seg.boneA, boneB, w1);
      }
    }
  }
  // end caps
  const first = segs[0], last = segs[segs.length - 1];
  const cap = (ring, pole, dir, bone) => {
    const verts = partFor(bone, undefined, mat);
    for (let i = 0; i < sides; i++) {
      const i2 = (i + 1) % sides;
      pushVert(verts, pole, dir, bone);
      pushVert(verts, ring[i2].p, ring[i2].n, bone);
      pushVert(verts, ring[i].p, ring[i].n, bone);
    }
  };
  const ax0 = norm(sub(stations[1].p, stations[0].p));
  cap(first.rings[0], stations[0].p, scl(ax0, -1), stations[0].bone);
  const axL = norm(sub(stations[stations.length - 1].p, stations[stations.length - 2].p));
  const lastBone = stations[stations.length - 1].bone;
  const verts = partFor(lastBone, undefined, mat);
  for (let i = 0; i < sides; i++) {
    const i2 = (i + 1) % sides;
    const ring = last.rings[last.rings.length - 1];
    pushVert(verts, stations[stations.length - 1].p, axL, lastBone);
    pushVert(verts, ring[i].p, ring[i].n, lastBone);
    pushVert(verts, ring[i2].p, ring[i2].n, lastBone);
  }
}

// Flat-shaded box for the few hard-surface details that want crisp edges.
function addBox(mat, boneA, boneB, c, s, rot = null) {
  const verts = partFor(boneA, boneB, mat);
  const hx = s[0] / 2, hy = s[1] / 2, hz = s[2] / 2;
  const P = [];
  for (const dx of [-hx, hx])
    for (const dy of [-hy, hy])
      for (const dz of [-hz, hz]) {
        let p = [dx, dy, dz];
        if (rot) {
          const q = axisQ(rot[0], rot[1]);
          const w = q[3], x = q[0], y = q[1], z = q[2];
          const t = scl(cross([x, y, z], p), 2);
          p = add(add(p, scl(t, w)), scl(cross([x, y, z], t), 1));
        }
        P.push(add(c, p));
      }
  const face = (a, b2, cc, dd, n) => {
    for (const i of [a, b2, cc, a, cc, dd]) {
      pushVert(verts, P[i], n, boneA, boneB);
    }
  };
  face(4, 5, 7, 6, [0, 0, 1]);
  face(1, 0, 2, 3, [0, 0, -1]);
  face(0, 1, 5, 4, [0, -1, 0]);
  face(2, 3, 7, 6, [0, 1, 0]);
  face(0, 2, 6, 4, [-1, 0, 0]);
  face(1, 3, 7, 5, [1, 0, 0]);
}

// ------------------------------------------------------------- sculpting ----
// Head (bound to `head`): skull, face patch, muzzle, nose, eyes, brows, ears.
addEllipsoid("fur", "head", null, [0, 1.47, 0], [0.125, 0.135, 0.12]);
addEllipsoid("cream", "head", null, [0, 1.45, 0.08], [0.095, 0.105, 0.06]);
addEllipsoid("skin", "head", null, [0, 1.415, 0.125], [0.05, 0.038, 0.042]);
addEllipsoid("dark", "head", null, [0, 1.435, 0.155], [0.016, 0.011, 0.012], 6, 4);
addEllipsoid("white", "head", null, [0.052, 1.485, 0.105], [0.023, 0.024, 0.016], 8, 5);
addEllipsoid("white", "head", null, [-0.052, 1.485, 0.105], [0.023, 0.024, 0.016], 8, 5);
addEllipsoid("dark", "head", null, [0.056, 1.485, 0.118], [0.011, 0.013, 0.011], 6, 4);
addEllipsoid("dark", "head", null, [-0.056, 1.485, 0.118], [0.011, 0.013, 0.011], 6, 4);
addBox("goldDeep", "head", null, [0.055, 1.522, 0.108], [0.052, 0.014, 0.02], [[0, 1, 0], 12]);
addBox("goldDeep", "head", null, [-0.055, 1.522, 0.108], [0.052, 0.014, 0.02], [[0, 1, 0], -12]);
addEllipsoid("fur", "head", null, [0.132, 1.465, 0], [0.022, 0.038, 0.03], 6, 5);
addEllipsoid("fur", "head", null, [-0.132, 1.465, 0], [0.022, 0.038, 0.03], 6, 5);
// hair cap + golden fillet (紧箍) + phoenix crown (凤翅紫金冠)
addEllipsoid("fur", "head", null, [0, 1.575, -0.01], [0.1, 0.055, 0.1], 8, 4);
addBand("gold", "head", null, [0, 1.565, 0], 0.128, 0.035, 16);
addEllipsoid("gold", "head", null, [0, 1.615, -0.01], [0.045, 0.03, 0.05], 8, 5);
// Two long curved plumes rising from the crown, swept back like the classic
// 凤翅紫金冠 silhouette. Each is a lofted tube so it bends instead of reading
// as a stick.
addTube("feather", [
  { p: [0.05, 1.66, -0.01], r: 0.017, bone: "head" },
  { p: [0.13, 1.88, -0.04], r: 0.021, bone: "head" },
  { p: [0.24, 2.06, -0.12], r: 0.014, bone: "head" },
  { p: [0.32, 2.16, -0.24], r: 0.006, bone: "head" },
], 5);
addTube("feather", [
  { p: [-0.05, 1.66, -0.01], r: 0.017, bone: "head" },
  { p: [-0.13, 1.88, -0.04], r: 0.021, bone: "head" },
  { p: [-0.24, 2.06, -0.12], r: 0.014, bone: "head" },
  { p: [-0.32, 2.16, -0.24], r: 0.006, bone: "head" },
], 5);
// gold crown base holding the plumes
addEllipsoid("gold", "head", null, [0, 1.7, -0.015], [0.024, 0.026, 0.024], 6, 4);

// Torso: pelvis, kilt with gold hem, belt buckle, abdomen, cuirass.
addEllipsoid("redDeep", "hips", "spine", [0, 0.8, 0], [0.155, 0.1, 0.115]);
// 虎皮裙: tiger-striped skirt with a ragged hem and a gold sash knot.
addBand("tiger", "hips", null, [0, 0.69, 0], 0.178, 0.19, 16);
for (let i = 0; i < 18; i++) {
  const a = (i / 18) * Math.PI * 2 + 0.19;
  const r = 0.183;
  const row = i % 2;
  addBox(
    "tigerStripe", "hips", null,
    [Math.cos(a) * r, 0.705 - row * 0.055, Math.sin(a) * r],
    [0.03, 0.05, 0.012],
    [[0, 1, 0], 90 - (a * 180) / Math.PI],
  );
}
addBand("gold", "hips", null, [0, 0.595, 0], 0.186, 0.03, 16);
addBand("gold", "hips", null, [0, 0.855, 0], 0.16, 0.045, 16);
addEllipsoid("goldDeep", "hips", null, [0, 0.855, 0.15], [0.045, 0.04, 0.03], 8, 5);
addCapsule("red", "spine", "chest", [0, 0.93, 0], [0, 1.1, 0], 0.115, 0.135, 10);
addEllipsoid("gold", "chest", null, [0, 1.15, 0.01], [0.16, 0.125, 0.115]);
addEllipsoid("goldDeep", "chest", null, [0, 1.05, 0.1], [0.1, 0.07, 0.05], 8, 5);
addBox("redDeep", "chest", null, [0, 1.16, 0.125], [0.09, 0.2, 0.02], [[0, 0, 1], 24]);
addEllipsoid("gold", "chest", null, [0.085, 1.235, 0.02], [0.02, 0.02, 0.02], 6, 4);
addEllipsoid("gold", "chest", null, [-0.085, 1.235, 0.02], [0.02, 0.02, 0.02], 6, 4);
addCapsule("fur", "neck", "head", [0, 1.27, 0], [0, 1.34, 0], 0.05, 0.055, 8, 0.5);

// Scarf: neck knot (static on neck) + flowing panels on scarf_1..3.
addBand("red", "neck", null, [0, 1.29, 0], 0.115, 0.06, 14);
// 项圈: gold torque ring with five beads on the front
addBand("gold", "chest", null, [0, 1.245, 0], 0.108, 0.022, 14);
for (let i = -2; i <= 2; i++) {
  const a = Math.PI / 2 + i * 0.42;
  addEllipsoid("goldDeep", "chest", null, [Math.cos(a) * 0.108, 1.24, Math.sin(a) * 0.108], [0.016, 0.016, 0.016], 6, 4);
}
addTube("red", [
  { p: [0, 1.24, -0.1], r: 0.075, bone: "scarf_1" },
  { p: [0, 1.12, -0.16], r: 0.06, bone: "scarf_2" },
  { p: [0, 0.99, -0.2], r: 0.045, bone: "scarf_3" },
], 6);
addTube("redDeep", [
  { p: [0.03, 1.22, -0.115], r: 0.035, bone: "scarf_1" },
  { p: [0.05, 1.08, -0.185], r: 0.028, bone: "scarf_2" },
  { p: [0.06, 0.95, -0.225], r: 0.02, bone: "scarf_3" },
], 5);

// Arms (T-pose along ±X): pauldron, sleeve, bracer, hand.
for (const side of ["l", "r"]) {
  const s = side === "l" ? 1 : -1;
  addEllipsoid("gold", `shoulder_${side}`, `upper_arm_${side}`, [s * 0.185, 1.255, 0], [0.075, 0.06, 0.075], 8, 5);
  addCapsule("red", `upper_arm_${side}`, `forearm_${side}`, [s * 0.22, 1.22, 0], [s * 0.44, 1.22, 0], 0.047, 0.042, 8);
  addCapsule("red", `forearm_${side}`, `hand_${side}`, [s * 0.46, 1.22, 0], [s * 0.64, 1.22, 0], 0.042, 0.036, 8);
  addBand("gold", `forearm_${side}`, null, [s * 0.62, 1.22, 0], 0.05, 0.06, 10);
  addEllipsoid("fur", `hand_${side}`, null, [s * 0.7, 1.22, 0], [0.05, 0.045, 0.045], 8, 5);
}
// 如意金箍棒 rigid to the right hand: shaft, gold caps, red collars.
// The staff rests tilted so that after the clips' 68° arm-down rotation it
// hangs vertical beside the body instead of raking across the legs.
const STAFF_ANCHOR = [-0.7, 1.22, 0.015];
const staffPt = (x, y, z) => {
  const dx = x - STAFF_ANCHOR[0], dy = y - STAFF_ANCHOR[1], dz = z - STAFF_ANCHOR[2];
  // 112° around Z so that the clips' 68° arm-down rotation leaves the staff
  // hanging straight down beside the body.
  const a = 112 * DEG, c = Math.cos(a), sn = Math.sin(a);
  return [STAFF_ANCHOR[0] + dx * c - dy * sn, STAFF_ANCHOR[1] + dx * sn + dy * c, STAFF_ANCHOR[2] + dz];
};
const staffSeg = (mat, y0, y1, r) =>
  addCapsule(mat, "hand_r", null, staffPt(-0.7, y0, 0.015), staffPt(-0.7, y1, 0.015), r, r, 8, 0);
staffSeg("iron", 0.52, 1.94, 0.019);
staffSeg("gold", 1.9, 2.0, 0.026);
staffSeg("gold", 0.46, 0.56, 0.026);
staffSeg("redDeep", 1.85, 1.88, 0.024);
staffSeg("redDeep", 0.59, 0.62, 0.024);

// Legs: thigh, knee, shin boot, gold cuff, upturned-toe shoe.
for (const side of ["l", "r"]) {
  const s = side === "l" ? 1 : -1;
  addCapsule("tiger", `thigh_${side}`, `shin_${side}`, [s * 0.09, 0.72, 0], [s * 0.09, 0.44, 0], 0.058, 0.05, 8);
  addEllipsoid("fur", `shin_${side}`, null, [s * 0.09, 0.42, 0.005], [0.052, 0.05, 0.055], 6, 5);
  addCapsule("boot", `shin_${side}`, `foot_${side}`, [s * 0.09, 0.4, 0], [s * 0.09, 0.13, 0], 0.05, 0.042, 8);
  addBand("gold", `foot_${side}`, null, [s * 0.09, 0.155, 0], 0.055, 0.025, 10);
  addCapsule("boot", `foot_${side}`, null, [s * 0.09, 0.055, -0.02], [s * 0.09, 0.06, 0.15], 0.045, 0.032, 8, 0.4);
  addEllipsoid("gold", `foot_${side}`, null, [s * 0.09, 0.075, 0.185], [0.022, 0.02, 0.028], 6, 4);
}

// Tail: three-bone lofted tube curving up behind, white tuft at the tip.
addTube("fur", [
  { p: [0, 0.75, -0.19], r: 0.036, bone: "tail_1" },
  { p: [0, 0.83, -0.3], r: 0.03, bone: "tail_2" },
  { p: [0, 0.95, -0.43], r: 0.024, bone: "tail_3" },
  { p: [0, 1.08, -0.48], r: 0.016, bone: "tail_3" },
], 6);
addEllipsoid("white", "tail_3", null, [0, 1.11, -0.49], [0.028, 0.032, 0.028], 6, 5);

// Ground: large flat quad, unskinned (w=0).
const groundVerts = [];
{
  const s = 12, y = -0.02, n = [0, 1, 0];
  const q = [[-s, y, -s], [s, y, -s], [s, y, s], [-s, y, s]];
  for (const tri of [[0, 2, 1], [0, 3, 2]])
    for (const i of tri)
      groundVerts.push(q[i][0], q[i][1], q[i][2], 0, n[0], n[1], n[2], 0, 0, 0, 0, 1, 0, 0, 0);
}

// --------------------------------------------------------------- buffer ----
const chunks = [];
let byteLength = 0;
const bufferViews = [];
const accessors = [];

function addFloatAccessor(values, kind, target) {
  const arr = new Float32Array(values);
  const offset = byteLength;
  chunks.push(Buffer.from(arr.buffer));
  byteLength += arr.byteLength;
  const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[kind];
  const count = arr.length / components;
  bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: arr.byteLength, target });
  const acc = {
    bufferView: bufferViews.length - 1,
    componentType: 5126,
    count,
    type: kind,
  };
  if (kind === "VEC3") {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < count; i++)
      for (let c = 0; c < 3; c++) {
        min[c] = Math.min(min[c], values[i * 3 + c]);
        max[c] = Math.max(max[c], values[i * 3 + c]);
      }
    acc.min = min;
    acc.max = max;
  }
  accessors.push(acc);
  return accessors.length - 1;
}

function addVec4Float(values) {
  return addFloatAccessor(values, "VEC4", 34962);
}
function addVec4Joints(values) {
  const arr = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i++) arr[i] = values[i];
  const offset = byteLength;
  const pad = (4 - (arr.byteLength % 4)) % 4;
  chunks.push(Buffer.from(arr.buffer), pad ? Buffer.alloc(pad) : null);
  byteLength += arr.byteLength + pad;
  bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: arr.byteLength, target: 34962 });
  accessors.push({
    bufferView: bufferViews.length - 1,
    componentType: 5121,
    count: values.length / 4,
    type: "VEC4",
  });
  return accessors.length - 1;
}
function addMat4ColumnMajor(rowMatrices) {
  const values = [];
  for (const m of rowMatrices)
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) values.push(m[r * 4 + c]);
  return addFloatAccessor(values, "MAT4", undefined);
}
function addScalarTimes(times) {
  return addFloatAccessor(times, "SCALAR", 34962);
}
function addVec4Quats(keys) {
  const values = [];
  for (const q of keys) values.push(q[0], q[1], q[2], q[3]);
  return addFloatAccessor(values, "VEC4", 34962);
}
function addVec3Translations(keys) {
  const values = [];
  for (const t of keys) values.push(t[0], t[1], t[2]);
  return addFloatAccessor(values, "VEC3", 34962);
}

const primitives = [];
const materials = [];
const materialIndex = new Map();
function materialFor(name) {
  if (!materialIndex.has(name)) {
    materialIndex.set(name, materials.length);
    const m = MATS[name];
    materials.push({
      name,
      doubleSided: true,
      pbrMetallicRoughness: {
        baseColorFactor: [...m.c, 1],
        metallicFactor: m.m,
        roughnessFactor: m.r,
      },
    });
  }
  return materialIndex.get(name);
}

for (const part of parts.values()) {
  const v = part.verts;
  const vertexCount = v.length / 15;
  const pos = [], nrm = [], jnt = [], wgt = [];
  for (let i = 0; i < vertexCount; i++) {
    const b = i * 15;
    pos.push(v[b], v[b + 1], v[b + 2]);
    nrm.push(v[b + 4], v[b + 5], v[b + 6]);
    jnt.push(v[b + 7], v[b + 8], v[b + 9], v[b + 10]);
    wgt.push(v[b + 11], v[b + 12], v[b + 13], v[b + 14]);
  }
  primitives.push({
    attributes: {
      POSITION: addFloatAccessor(pos, "VEC3", 34962),
      NORMAL: addFloatAccessor(nrm, "VEC3", 34962),
      JOINTS_0: addVec4Joints(jnt),
      WEIGHTS_0: addVec4Float(wgt),
    },
    material: materialFor(part.mat),
    mode: 4,
  });
}
{
  const vertexCount = groundVerts.length / 15;
  const pos = [], nrm = [], jnt = [], wgt = [];
  for (let i = 0; i < vertexCount; i++) {
    const b = i * 15;
    pos.push(groundVerts[b], groundVerts[b + 1], groundVerts[b + 2]);
    nrm.push(groundVerts[b + 4], groundVerts[b + 5], groundVerts[b + 6]);
    jnt.push(0, 0, 0, 0);
    wgt.push(1, 0, 0, 0);
  }
  var groundPrimitive = {
    attributes: {
      POSITION: addFloatAccessor(pos, "VEC3", 34962),
      NORMAL: addFloatAccessor(nrm, "VEC3", 34962),
      JOINTS_0: addVec4Joints(jnt),
      WEIGHTS_0: addVec4Float(wgt),
    },
    material: materialFor("ground"),
    mode: 4,
  };
}

// ----------------------------------------------------------- animations ----
const clipDefs = [];

function walkRunClip({ duration, legAmp, kneeAmp, armAmp, lean, bob, name }) {
  const t = f => f * duration;
  clipDefs.push({
    name,
    channels: [
      { bone: "thigh_l", keys: [[t(0), RX(-legAmp)], [t(0.25), RX(0)], [t(0.5), RX(legAmp)], [t(0.75), RX(0)], [t(1), RX(-legAmp)]] },
      { bone: "thigh_r", keys: [[t(0), RX(legAmp)], [t(0.25), RX(0)], [t(0.5), RX(-legAmp)], [t(0.75), RX(0)], [t(1), RX(legAmp)]] },
      { bone: "shin_l", keys: [[t(0), RX(0)], [t(0.25), RX(kneeAmp * 0.5)], [t(0.5), RX(0)], [t(0.75), RX(kneeAmp)], [t(1), RX(0)]] },
      { bone: "shin_r", keys: [[t(0), RX(0)], [t(0.25), RX(kneeAmp)], [t(0.5), RX(0)], [t(0.75), RX(kneeAmp * 0.5)], [t(1), RX(0)]] },
      { bone: "upper_arm_l", keys: [[t(0), swingL(armAmp)], [t(0.5), swingL(-armAmp)], [t(1), swingL(armAmp)]] },
      { bone: "upper_arm_r", keys: [[t(0), swingR(-armAmp)], [t(0.5), swingR(armAmp)], [t(1), swingR(-armAmp)]] },
      { bone: "forearm_l", keys: [[t(0), RX(-14)], [t(0.5), RX(-26)], [t(1), RX(-14)]] },
      { bone: "forearm_r", keys: [[t(0), RX(-26)], [t(0.5), RX(-14)], [t(1), RX(-26)]] },
      { bone: "spine", keys: [[0, RX(-lean)], [t(1), RX(-lean)]] },
      { bone: "tail_1", keys: [[t(0), RY(12)], [t(0.5), RY(-12)], [t(1), RY(12)]] },
      { bone: "tail_2", keys: [[t(0), RY(16)], [t(0.5), RY(-16)], [t(1), RY(16)]] },
      { bone: "tail_3", keys: [[t(0), RY(20)], [t(0.5), RY(-20)], [t(1), RY(20)]] },
      { bone: "scarf_1", keys: [[t(0), RX(14)], [t(0.5), RX(4)], [t(1), RX(14)]] },
      { bone: "scarf_2", keys: [[t(0), RX(20)], [t(0.5), RX(6)], [t(1), RX(20)]] },
      { bone: "scarf_3", keys: [[t(0), RX(26)], [t(0.5), RX(8)], [t(1), RX(26)]] },
      {
        bone: "hips", path: "translation", keys: [
          [t(0), [0, 0.78, 0]], [t(0.25), [0, 0.78 + bob, 0]], [t(0.5), [0, 0.78, 0]],
          [t(0.75), [0, 0.78 + bob, 0]], [t(1), [0, 0.78, 0]],
        ],
      },
    ],
  });
}

clipDefs.push({
  name: "idle",
  channels: [
    { bone: "upper_arm_l", keys: [[0, swingL(4)], [1.2, swingL(-4)], [2.4, swingL(4)]] },
    { bone: "upper_arm_r", keys: [[0, swingR(-4)], [1.2, swingR(4)], [2.4, swingR(-4)]] },
    { bone: "spine", keys: [[0, RX(2)], [1.2, RX(-2)], [2.4, RX(2)]] },
    { bone: "head", keys: [[0, RY(-6)], [1.2, RY(6)], [2.4, RY(-6)]] },
    { bone: "tail_1", keys: [[0, RY(10)], [0.8, RY(-10)], [1.6, RY(10)], [2.4, RY(-10)]] },
    { bone: "tail_2", keys: [[0, RY(-14)], [0.8, RY(14)], [1.6, RY(-14)], [2.4, RY(14)]] },
    { bone: "tail_3", keys: [[0, RY(18)], [0.8, RY(-18)], [1.6, RY(18)], [2.4, RY(-18)]] },
    { bone: "scarf_1", keys: [[0, RX(6)], [1.2, RX(12)], [2.4, RX(6)]] },
    { bone: "scarf_2", keys: [[0, RX(10)], [1.2, RX(18)], [2.4, RX(10)]] },
    { bone: "scarf_3", keys: [[0, RX(14)], [1.2, RX(24)], [2.4, RX(14)]] },
    {
      bone: "hips", path: "translation", keys: [
        [0, [0, 0.78, 0]], [1.2, [0, 0.79, 0]], [2.4, [0, 0.78, 0]],
      ],
    },
  ],
});
walkRunClip({ name: "walk", duration: 0.8, legAmp: 26, kneeAmp: 42, armAmp: 18, lean: 6, bob: 0.015 });
walkRunClip({ name: "run", duration: 0.5, legAmp: 44, kneeAmp: 68, armAmp: 34, lean: 14, bob: 0.03 });

clipDefs.push({
  name: "jump",
  channels: [
    // Small relative bob only; the world-space arc is driven procedurally by
    // the app so the character root height stays under physics control.
    {
      bone: "hips", path: "translation", keys: [
        [0, [0, 0.78, 0]], [0.15, [0, 0.7, 0]], [0.3, [0, 0.81, 0]],
        [0.45, [0, 0.82, 0]], [0.6, [0, 0.71, 0]], [0.75, [0, 0.78, 0]],
      ],
    },
    { bone: "thigh_l", keys: [[0, RX(0)], [0.15, RX(-35)], [0.3, RX(-55)], [0.45, RX(-20)], [0.6, RX(-40)], [0.75, RX(0)]] },
    { bone: "thigh_r", keys: [[0, RX(0)], [0.15, RX(-35)], [0.3, RX(-45)], [0.45, RX(-10)], [0.6, RX(-35)], [0.75, RX(0)]] },
    { bone: "shin_l", keys: [[0, RX(0)], [0.15, RX(70)], [0.3, RX(60)], [0.45, RX(10)], [0.6, RX(60)], [0.75, RX(0)]] },
    { bone: "shin_r", keys: [[0, RX(0)], [0.15, RX(70)], [0.3, RX(50)], [0.45, RX(5)], [0.6, RX(55)], [0.75, RX(0)]] },
    { bone: "upper_arm_l", keys: [[0, swingL(0)], [0.15, mulQ(RZ(20), ARM_DOWN_L)], [0.3, mulQ(RZ(-70), ARM_DOWN_L)], [0.45, mulQ(RZ(-85), ARM_DOWN_L)], [0.6, mulQ(RZ(15), ARM_DOWN_L)], [0.75, swingL(0)]] },
    { bone: "upper_arm_r", keys: [[0, swingR(0)], [0.15, mulQ(RZ(-20), ARM_DOWN_R)], [0.3, mulQ(RZ(70), ARM_DOWN_R)], [0.45, mulQ(RZ(85), ARM_DOWN_R)], [0.6, mulQ(RZ(-15), ARM_DOWN_R)], [0.75, swingR(0)]] },
    { bone: "spine", keys: [[0, RX(0)], [0.15, RX(-18)], [0.3, RX(8)], [0.45, RX(8)], [0.6, RX(-14)], [0.75, RX(0)]] },
    { bone: "tail_1", keys: [[0, RX(0)], [0.3, RX(-25)], [0.6, RX(-15)], [0.75, RX(0)]] },
    { bone: "tail_2", keys: [[0, RX(0)], [0.3, RX(-30)], [0.6, RX(-18)], [0.75, RX(0)]] },
    { bone: "tail_3", keys: [[0, RX(0)], [0.3, RX(-35)], [0.6, RX(-22)], [0.75, RX(0)]] },
    { bone: "scarf_1", keys: [[0, RX(0)], [0.3, RX(-30)], [0.75, RX(0)]] },
    { bone: "scarf_2", keys: [[0, RX(0)], [0.3, RX(-40)], [0.75, RX(0)]] },
    { bone: "scarf_3", keys: [[0, RX(0)], [0.3, RX(-50)], [0.75, RX(0)]] },
  ],
});

clipDefs.push({
  name: "attack",
  channels: [
    {
      bone: "upper_arm_r", keys: [
        [0, swingR(0)], [0.2, mulQ(RY(55), mulQ(RZ(-30), ARM_DOWN_R))],
        [0.4, mulQ(RY(-70), mulQ(RZ(-15), ARM_DOWN_R))],
        [0.6, mulQ(RY(-30), mulQ(RZ(-5), ARM_DOWN_R))], [0.9, swingR(0)],
      ],
    },
    { bone: "forearm_r", keys: [[0, IDQ], [0.2, RZ(35)], [0.4, RZ(-25)], [0.6, RZ(-10)], [0.9, IDQ]] },
    { bone: "spine", keys: [[0, IDQ], [0.2, mulQ(RX(-6), RY(22))], [0.4, mulQ(RX(-10), RY(-26))], [0.6, RY(-10)], [0.9, IDQ]] },
    { bone: "upper_arm_l", keys: [[0, swingL(0)], [0.25, swingL(-25)], [0.45, swingL(20)], [0.9, swingL(0)]] },
    { bone: "thigh_r", keys: [[0, RX(0)], [0.4, RX(-14)], [0.6, RX(-8)], [0.9, RX(0)]] },
    { bone: "shin_r", keys: [[0, RX(0)], [0.4, RX(18)], [0.6, RX(10)], [0.9, RX(0)]] },
    { bone: "head", keys: [[0, IDQ], [0.25, RY(12)], [0.45, RY(-14)], [0.9, IDQ]] },
    { bone: "tail_1", keys: [[0, IDQ], [0.3, RX(-20)], [0.9, IDQ]] },
    { bone: "tail_2", keys: [[0, IDQ], [0.3, RX(-26)], [0.9, IDQ]] },
    { bone: "scarf_1", keys: [[0, IDQ], [0.35, RX(-24)], [0.9, IDQ]] },
    { bone: "scarf_2", keys: [[0, IDQ], [0.35, RX(-34)], [0.9, IDQ]] },
    { bone: "scarf_3", keys: [[0, IDQ], [0.35, RX(-44)], [0.9, IDQ]] },
    {
      bone: "hips", path: "translation", keys: [
        [0, [0, 0.78, 0]], [0.2, [0, 0.75, 0]], [0.4, [0, 0.76, 0.06]],
        [0.6, [0, 0.77, 0.03]], [0.9, [0, 0.78, 0]],
      ],
    },
  ],
});

// -------------------------------------------------------------- glTF doc ----
const nodes = BONES.map((b, i) => ({
  name: b.name,
  translation: b.t,
  children: BONES.map((o, j) => (o.parent === i ? j : -1)).filter(j => j >= 0),
}));
const characterNode = { name: "wukong", mesh: 0, skin: 0, children: [0] };
const groundNode = { name: "ground", mesh: 1 };
nodes.push(characterNode, groundNode);

const animations = clipDefs.map(clip => {
  const channels = [];
  const samplers = [];
  for (const ch of clip.channels) {
    const boneIndex = BONE_INDEX[ch.bone];
    const times = ch.keys.map(k => k[0]);
    if (ch.path === "translation") {
      samplers.push({
        input: addScalarTimes(times),
        interpolation: "LINEAR",
        output: addVec3Translations(ch.keys.map(k => k[1])),
      });
      channels.push({ sampler: samplers.length - 1, target: { node: boneIndex, path: "translation" } });
    } else {
      samplers.push({
        input: addScalarTimes(times),
        interpolation: "LINEAR",
        output: addVec4Quats(ch.keys.map(k => k[1])),
      });
      channels.push({ sampler: samplers.length - 1, target: { node: boneIndex, path: "rotation" } });
    }
  }
  return { name: clip.name, channels, samplers };
});

// The skin's inverse bind matrices must be appended to the buffer BEFORE it
// is serialized; otherwise its buffer view points past the end.
const inverse_bind_accessor = addMat4ColumnMajor(INVERSE_BIND);
const buffer = Buffer.concat(chunks.filter(Boolean));
const gltf = {
  asset: { version: "2.0", generator: "generate-wukong-gltf.mjs" },
  scene: 0,
  scenes: [{ name: "wukong_scene", nodes: [nodes.length - 2, nodes.length - 1] }],
  nodes,
  skins: [{
    name: "wukong_skin",
    joints: BONES.map((_, i) => i),
    skeleton: 0,
    inverseBindMatrices: inverse_bind_accessor,
  }],
  meshes: [
    { name: "wukong_body", primitives },
    { name: "ground", primitives: [groundPrimitive] },
  ],
  materials,
  animations,
  accessors,
  bufferViews,
  buffers: [{
    byteLength: buffer.length,
    uri: `data:application/octet-stream;base64,${buffer.toString("base64")}`,
  }],
};

writeFileSync(outPath, JSON.stringify(gltf));
const totalVerts = primitives.reduce((n, p) => n + accessors[p.attributes.POSITION].count, 0);
console.log(
  `wrote ${outPath}: ${primitives.length} primitives, ${totalVerts} skinned verts, ` +
  `${BONES.length} bones, ${animations.length} clips [${animations.map(a => a.name).join(", ")}], ` +
  `buffer ${buffer.length} bytes`,
);
