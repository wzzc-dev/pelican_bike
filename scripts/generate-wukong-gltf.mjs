#!/usr/bin/env node
/**
 * scripts/generate-wukong-gltf.mjs
 *
 * Procedurally builds a low-poly Sun Wukong (孙悟空) glTF 2.0 asset with a
 * skinned skeleton and four animation clips (walk, run, jump, attack), and
 * writes it as a single self-contained .gltf file (binary payload embedded as
 * a base64 data URI).
 *
 * The output targets the subset `wzzc-dev/moui_3d`'s glTF loader supports:
 * triangle lists (no indices), POSITION/NORMAL/JOINTS_0/WEIGHTS_0, one skin,
 * LINEAR quaternion/translation channels, pbrMetallicRoughness baseColorFactor
 * materials, and no extensions of any kind.
 *
 * Usage: node scripts/generate-wukong-gltf.mjs [outPath]
 */

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const outPath =
  process.argv[2] ??
  resolve(dirname(fileURLToPath(import.meta.url)), "../app/wukong.gltf");

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
// The rest pose is a T-pose; every clip lowers the arms first so swings read
// as natural limb motion instead of windmilling horizontals.
const ARM_DOWN_L = RZ0(-68);
const ARM_DOWN_R = RZ0(68);
function RZ0(d) { const r = (d * DEG) / 2; return [0, 0, Math.sin(r), Math.cos(r)]; }
const swingL = a => mulQ(RY(a), ARM_DOWN_L);
const swingR = a => mulQ(RY(a), ARM_DOWN_R);

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
const qToM = q => {
  const [x, y, z, w] = q;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 0,
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 0,
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), 0,
    0, 0, 0, 1,
  ];
};
const invRigid = m => {
  // inverse of a rotation+translation matrix (no scale)
  const r = [
    [m[0], m[1], m[2]],
    [m[4], m[5], m[6]],
    [m[8], m[9], m[10]],
  ];
  const t = [m[3], m[7], m[11]];
  const rt = [
    [r[0][0], r[1][0], r[2][0]],
    [r[0][1], r[1][1], r[2][1]],
    [r[0][2], r[1][2], r[2][2]],
  ];
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
  { name: "scarf_1", parent: 3, t: [0, 0.1, -0.08] },
  { name: "scarf_2", parent: 22, t: [0, -0.1, -0.05] },
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

// ------------------------------------------------------------- geometry ----
// boxes grouped by (joint, color); each box emits 36 flat-shaded verts.
const parts = new Map(); // key -> { joint, color, verts: [] }
const addBox = (joint, color, cx, cy, cz, sx, sy, sz, skew = null) => {
  const key = `${joint}|${color.join(",")}`;
  if (!parts.has(key)) parts.set(key, { joint, color, verts: [] });
  const verts = parts.get(key).verts;
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  const P = [];
  for (const dx of [-hx, hx])
    for (const dy of [-hy, hy])
      for (const dz of [-hz, hz]) {
        let x = cx + dx, y = cy + dy, z = cz + dz;
        if (skew) {
          const [ax, ay, az] = skew.axis;
          const along = ax ? x - cx : ay ? y - cy : z - cz;
          const off = along * skew.k;
          x += skew.dir[0] * off;
          y += skew.dir[1] * off;
          z += skew.dir[2] * off;
        }
        P.push([x, y, z]);
      }
  // P order: (-,-,-) (-,-,+) (-,+,-) (-,+,+) (+,-,-) (+,-,+) (+,+,-) (+,+,+)
  const face = (a, b, c, d, n) => {
    for (const i of [a, b, c, a, c, d]) {
      const p = P[i];
      verts.push(p[0], p[1], p[2], 1, n[0], n[1], n[2],
        BONE_INDEX[joint], 0, 0, 0, 1, 0, 0, 0);
    }
  };
  face(4, 5, 7, 6, [0, 0, 1]);
  face(1, 0, 2, 3, [0, 0, -1]);
  face(0, 1, 5, 4, [0, -1, 0]);
  face(2, 3, 7, 6, [0, 1, 0]);
  face(0, 2, 6, 4, [-1, 0, 0]);
  face(1, 3, 7, 5, [1, 0, 0]);
};

const C = {
  fur: [0.55, 0.38, 0.22],
  face: [0.94, 0.79, 0.64],
  gold: [0.88, 0.72, 0.24],
  goldDark: [0.62, 0.46, 0.14],
  red: [0.78, 0.2, 0.17],
  redDeep: [0.52, 0.11, 0.11],
  boot: [0.12, 0.11, 0.13],
  pants: [0.24, 0.3, 0.44],
  white: [0.92, 0.91, 0.86],
  iron: [0.36, 0.37, 0.4],
};

// head group
addBox("head", C.fur, 0, 1.52, 0, 0.24, 0.24, 0.24);
addBox("head", C.face, 0, 1.48, 0.125, 0.15, 0.12, 0.02);
addBox("head", C.fur, 0.13, 1.55, 0, 0.05, 0.09, 0.05);
addBox("head", C.fur, -0.13, 1.55, 0, 0.05, 0.09, 0.05);
// golden fillet (紧箍) + phoenix crown (凤翅紫金冠)
addBox("head", C.gold, 0, 1.615, 0.02, 0.25, 0.035, 0.25);
addBox("head", C.gold, 0, 1.66, -0.02, 0.1, 0.06, 0.14);
addBox("head", C.red, 0.06, 1.72, -0.02, 0.02, 0.12, 0.1);
addBox("head", C.red, -0.06, 1.72, -0.02, 0.02, 0.12, 0.1);
// torso
addBox("chest", C.gold, 0, 1.16, 0, 0.3, 0.24, 0.18);
addBox("chest", C.goldDark, 0, 1.06, 0.005, 0.31, 0.05, 0.19);
addBox("spine", C.red, 0, 0.99, 0, 0.26, 0.12, 0.16);
addBox("hips", C.redDeep, 0, 0.8, 0, 0.28, 0.16, 0.18);
addBox("hips", C.gold, 0, 0.72, 0, 0.29, 0.05, 0.19);
addBox("neck", C.fur, 0, 1.32, 0, 0.09, 0.08, 0.09);
// pauldrons
addBox("shoulder_l", C.gold, 0.19, 1.26, 0, 0.12, 0.08, 0.16);
addBox("shoulder_r", C.gold, -0.19, 1.26, 0, 0.12, 0.08, 0.16);
// arms (T-pose along ±X)
addBox("upper_arm_l", C.red, 0.31, 1.24, 0, 0.22, 0.09, 0.1);
addBox("forearm_l", C.red, 0.53, 1.24, 0, 0.2, 0.08, 0.09);
addBox("forearm_l", C.gold, 0.63, 1.24, 0, 0.04, 0.1, 0.11);
addBox("hand_l", C.fur, 0.71, 1.24, 0, 0.1, 0.08, 0.09);
addBox("upper_arm_r", C.red, -0.31, 1.24, 0, 0.22, 0.09, 0.1);
addBox("forearm_r", C.red, -0.53, 1.24, 0, 0.2, 0.08, 0.09);
addBox("forearm_r", C.gold, -0.63, 1.24, 0, 0.04, 0.1, 0.11);
addBox("hand_r", C.fur, -0.71, 1.24, 0, 0.1, 0.08, 0.09);
// legs
addBox("thigh_l", C.pants, 0.09, 0.58, 0, 0.13, 0.3, 0.14);
addBox("shin_l", C.boot, 0.09, 0.27, 0, 0.12, 0.28, 0.13);
addBox("foot_l", C.boot, 0.09, 0.05, 0.06, 0.12, 0.1, 0.24);
addBox("thigh_r", C.pants, -0.09, 0.58, 0, 0.13, 0.3, 0.14);
addBox("shin_r", C.boot, -0.09, 0.27, 0, 0.12, 0.28, 0.13);
addBox("foot_r", C.boot, -0.09, 0.05, 0.06, 0.12, 0.1, 0.24);
// tail (two segments, slight down-angle baked into geometry)
addBox("tail_1", C.fur, 0, 0.8, -0.2, 0.06, 0.06, 0.16);
addBox("tail_2", C.fur, 0, 0.86, -0.34, 0.05, 0.05, 0.14);
addBox("tail_2", C.white, 0, 0.9, -0.42, 0.06, 0.06, 0.06);
// scarf (neck knot + flowing tail, weighted to scarf bones)
addBox("scarf_1", C.red, 0, 1.3, -0.06, 0.24, 0.07, 0.12);
addBox("scarf_2", C.red, 0, 1.16, -0.14, 0.18, 0.24, 0.04, { axis: [0, 1, 0], k: 0.35, dir: [0, 0, -1] });
// 如意金箍棒: rigid to right hand, held vertical beside the body
addBox("hand_r", C.gold, -0.71, 1.24, 0, 0.05, 0.14, 0.05);
addBox("hand_r", C.iron, -0.71, 1.24, 0, 0.035, 1.3, 0.035);
addBox("hand_r", C.gold, -0.71, 1.92, 0, 0.05, 0.08, 0.05);
addBox("hand_r", C.redDeep, -0.71, 0.6, 0, 0.045, 0.06, 0.045);

// ground: huge flat box, no skin (joint null)
const groundVerts = [];
{
  const s = 12, y = -0.02, n = [0, 1, 0];
  const q = [[-s, y, -s], [s, y, -s], [s, y, s], [-s, y, s]];
  const c = [0.16, 0.19, 0.24];
  for (const tri of [[0, 2, 1], [0, 3, 2]])
    for (const i of tri)
      groundVerts.push(q[i][0], q[i][1], q[i][2], 0, n[0], n[1], n[2], 0, 0, 0, 0, 1, 0, 0, 0);
  // reuse color via material, c unused here (kept for clarity)
  void c;
}

// --------------------------------------------------------------- buffer ----
const chunks = []; // { data: Float32Array|Uint8Array..., target }
let byteLength = 0;
const bufferViews = [];
const accessors = [];

function addFloatAccessor(values, kind, target) {
  const arr = new Float32Array(values);
  const offset = byteLength;
  chunks.push(Buffer.from(arr.buffer));
  byteLength += arr.byteLength;
  const count = arr.length / { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[kind];
  bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: arr.byteLength, target });
  const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[kind];
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

function addVec3Positions(values) {
  const idx = addFloatAccessor(values, "VEC3", 34962);
  return idx;
}
function addVec3Normals(values) {
  return addFloatAccessor(values, "VEC3", 34962);
}
function addVec4Joints(values) {
  // UNSIGNED_BYTE VEC4 joints
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

// mesh vertex attributes
const primitives = [];
const materials = [];
const materialIndex = new Map();
function materialFor(color) {
  const key = color.join(",");
  if (!materialIndex.has(key)) {
    materialIndex.set(key, materials.length);
    materials.push({
      name: `mat_${materials.length}`,
      doubleSided: true,
      pbrMetallicRoughness: { baseColorFactor: [...color, 1], metallicFactor: 0.1, roughnessFactor: 0.8 },
    });
  }
  return materialIndex.get(key);
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
      POSITION: addVec3Positions(pos),
      NORMAL: addVec3Normals(nrm),
      JOINTS_0: addVec4Joints(jnt),
      WEIGHTS_0: addFloatAccessor(wgt, "VEC4", 34962),
    },
    material: materialFor(part.color),
    mode: 4,
  });
}
const groundPos = [], groundNrm = [], groundJnt = [], groundWgt = [];
for (let i = 0; i < groundVerts.length / 15; i++) {
  const b = i * 15;
  groundPos.push(groundVerts[b], groundVerts[b + 1], groundVerts[b + 2]);
  groundNrm.push(groundVerts[b + 4], groundVerts[b + 5], groundVerts[b + 6]);
  groundJnt.push(0, 0, 0, 0);
  groundWgt.push(1, 0, 0, 0);
}
const groundPrimitive = {
  attributes: {
    POSITION: addVec3Positions(groundPos),
    NORMAL: addVec3Normals(groundNrm),
    JOINTS_0: addVec4Joints(groundJnt),
    WEIGHTS_0: addFloatAccessor(groundWgt, "VEC4", 34962),
  },
  material: materialFor([0.16, 0.19, 0.24]),
  mode: 4,
};

// ----------------------------------------------------------- animations ----
// A channel spec: { bone, path, keys: [[time, value]] }
const clipDefs = [];

function walkRunClip({ duration, legAmp, kneeAmp, armAmp, lean, bob, name }) {
  const t = f => f * duration;
  const channels = [
    {
      bone: "thigh_l", keys: [
        [t(0), RX(-legAmp)], [t(0.25), RX(0)], [t(0.5), RX(legAmp)],
        [t(0.75), RX(0)], [t(1), RX(-legAmp)],
      ],
    },
    {
      bone: "thigh_r", keys: [
        [t(0), RX(legAmp)], [t(0.25), RX(0)], [t(0.5), RX(-legAmp)],
        [t(0.75), RX(0)], [t(1), RX(legAmp)],
      ],
    },
    {
      bone: "shin_l", keys: [
        [t(0), RX(0)], [t(0.25), RX(kneeAmp * 0.5)], [t(0.5), RX(0)],
        [t(0.75), RX(kneeAmp)], [t(1), RX(0)],
      ],
    },
    {
      bone: "shin_r", keys: [
        [t(0), RX(0)], [t(0.25), RX(kneeAmp)], [t(0.5), RX(0)],
        [t(0.75), RX(kneeAmp * 0.5)], [t(1), RX(0)],
      ],
    },
    {
      bone: "upper_arm_l", keys: [
        [t(0), swingL(armAmp)], [t(0.5), swingL(-armAmp)], [t(1), swingL(armAmp)],
      ],
    },
    {
      bone: "upper_arm_r", keys: [
        [t(0), swingR(-armAmp)], [t(0.5), swingR(armAmp)], [t(1), swingR(-armAmp)],
      ],
    },
    {
      bone: "spine", keys: [[0, RX(-lean)], [t(1), RX(-lean)]],
    },
    {
      bone: "tail_1", keys: [
        [t(0), RY(12)], [t(0.5), RY(-12)], [t(1), RY(12)],
      ],
    },
    {
      bone: "scarf_1", keys: [
        [t(0), RX(14)], [t(0.5), RX(4)], [t(1), RX(14)],
      ],
    },
    {
      bone: "scarf_2", keys: [
        [t(0), RX(20)], [t(0.5), RX(6)], [t(1), RX(20)],
      ],
    },
    {
      bone: "hips", path: "translation", keys: [
        [t(0), [0, 0.78, 0]], [t(0.25), [0, 0.78 + bob, 0]],
        [t(0.5), [0, 0.78, 0]], [t(0.75), [0, 0.78 + bob, 0]],
        [t(1), [0, 0.78, 0]],
      ],
    },
  ];
  clipDefs.push({ name, channels });
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
    { bone: "scarf_1", keys: [[0, RX(6)], [1.2, RX(12)], [2.4, RX(6)]] },
    { bone: "scarf_2", keys: [[0, RX(10)], [1.2, RX(18)], [2.4, RX(10)]] },
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
    {
      bone: "thigh_l", keys: [
        [0, RX(0)], [0.15, RX(-35)], [0.3, RX(-55)], [0.45, RX(-20)],
        [0.6, RX(-40)], [0.75, RX(0)],
      ],
    },
    {
      bone: "thigh_r", keys: [
        [0, RX(0)], [0.15, RX(-35)], [0.3, RX(-45)], [0.45, RX(-10)],
        [0.6, RX(-35)], [0.75, RX(0)],
      ],
    },
    {
      bone: "shin_l", keys: [
        [0, RX(0)], [0.15, RX(70)], [0.3, RX(60)], [0.45, RX(10)],
        [0.6, RX(60)], [0.75, RX(0)],
      ],
    },
    {
      bone: "shin_r", keys: [
        [0, RX(0)], [0.15, RX(70)], [0.3, RX(50)], [0.45, RX(5)],
        [0.6, RX(55)], [0.75, RX(0)],
      ],
    },
    {
      bone: "upper_arm_l", keys: [
        [0, swingL(0)], [0.15, mulQ(RZ(20), ARM_DOWN_L)], [0.3, mulQ(RZ(-70), ARM_DOWN_L)],
        [0.45, mulQ(RZ(-85), ARM_DOWN_L)], [0.6, mulQ(RZ(15), ARM_DOWN_L)], [0.75, swingL(0)],
      ],
    },
    {
      bone: "upper_arm_r", keys: [
        [0, swingR(0)], [0.15, mulQ(RZ(-20), ARM_DOWN_R)], [0.3, mulQ(RZ(70), ARM_DOWN_R)],
        [0.45, mulQ(RZ(85), ARM_DOWN_R)], [0.6, mulQ(RZ(-15), ARM_DOWN_R)], [0.75, swingR(0)],
      ],
    },
    {
      bone: "spine", keys: [
        [0, RX(0)], [0.15, RX(-18)], [0.3, RX(8)], [0.45, RX(8)],
        [0.6, RX(-14)], [0.75, RX(0)],
      ],
    },
    {
      bone: "tail_1", keys: [[0, RY(0)], [0.3, RX(-25)], [0.6, RX(-15)], [0.75, RY(0)]],
    },
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
    {
      bone: "forearm_r", keys: [
        [0, IDQ], [0.2, RZ(35)], [0.4, RZ(-25)], [0.6, RZ(-10)], [0.9, IDQ],
      ],
    },
    {
      bone: "spine", keys: [
        [0, IDQ], [0.2, mulQ(RX(-6), RY(22))], [0.4, mulQ(RX(-10), RY(-26))],
        [0.6, RY(-10)], [0.9, IDQ],
      ],
    },
    {
      bone: "upper_arm_l", keys: [
        [0, swingL(0)], [0.25, swingL(-25)], [0.45, swingL(20)], [0.9, swingL(0)],
      ],
    },
    {
      bone: "thigh_r", keys: [[0, RX(0)], [0.4, RX(-14)], [0.6, RX(-8)], [0.9, RX(0)]],
    },
    {
      bone: "shin_r", keys: [[0, RX(0)], [0.4, RX(18)], [0.6, RX(10)], [0.9, RX(0)]],
    },
    {
      bone: "head", keys: [[0, IDQ], [0.25, RY(12)], [0.45, RY(-14)], [0.9, IDQ]],
    },
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
const characterNode = {
  name: "wukong",
  mesh: 0,
  skin: 0,
  children: [0],
};
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
