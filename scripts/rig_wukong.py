#!/usr/bin/env python3
"""
scripts/rig_wukong.py

Takes the downloaded static Sun Wukong GLB (909k verts, no skeleton, 4K PBR
texture), and turns it into a skinned, animated glTF for the MoUI demo:

  1. decimate to a target face count, replaying the collapse history on UVs
     and normals so nothing slides;
  2. bake baseColor texture -> per-vertex RGB, k-means into a small palette,
     one primitive per palette entry (the skin renderer only knows per-
     material colors, so palette splitting is the zero-shader-change way to
     get painted color + per-cluster metallic gold);
  3. estimate a 26-bone skeleton from the measured anatomy, auto-skin with
     two-nearest-capsule smooth weights, rigid-assign staff/plumes/feet;
  4. emit idle/walk/run/jump/attack clips for the new rest pose.

Usage: python3 scripts/rig_wukong.py <src.glb> <out.gltf> [target_faces]
"""
import json
import base64
import struct
import sys
import time

import numpy as np
import trimesh
from fast_simplification import simplify, replay_simplification

SRC = sys.argv[1]
DST = sys.argv[2]
TARGET_FACES = int(sys.argv[3]) if len(sys.argv) > 3 else 40000
SCALE = 1.55  # model is 1.073 tall; scale to ~1.66m like the demo expects

t0 = time.time()


def log(msg):
    print(f"[{time.time() - t0:6.1f}s] {msg}", flush=True)


# ---------------------------------------------------------------- load ----
mesh = trimesh.load(SRC, force="mesh", process=False)
v = np.ascontiguousarray(mesh.vertices, dtype=np.float64)
f = np.ascontiguousarray(mesh.faces, dtype=np.int32)
uv = np.asarray(mesh.visual.uv, dtype=np.float64)
nrm = np.ascontiguousarray(mesh.vertex_normals, dtype=np.float64)
log(f"loaded {len(v)}v {len(f)}f")

sv, sf, collapses = simplify(v, f, target_count=TARGET_FACES, agg=6.0,
                             return_collapses=True, verbose=False)
uv3 = np.ascontiguousarray(np.concatenate([uv, np.zeros((len(uv), 1))], axis=1), dtype=np.float32)
ruv, _, _ = replay_simplification(uv3, f, collapses)
rn, _, _ = replay_simplification(np.ascontiguousarray(nrm, dtype=np.float32), f, collapses)
V = sv.astype(np.float64) * SCALE
F = sf.astype(np.int64)
UV = ruv[:, :2].astype(np.float64)
N = rn[:, :3].astype(np.float64)
N /= np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-9)
log(f"decimated -> {len(V)}v {len(F)}f")

rgba = np.asarray(mesh.visual.material.baseColorTexture.convert("RGB")).astype(np.float64) / 255.0
H, W = rgba.shape[:2]
tx = np.clip((UV[:, 0] % 1.0 * (W - 1)).round().astype(int), 0, W - 1)
ty = np.clip(((1.0 - UV[:, 1]) % 1.0 * (H - 1)).round().astype(int), 0, H - 1)
C = rgba[ty, tx]
log("sampled vertex colors")

# ------------------------------------------------------------- palette ----
K = 14
rng = np.random.default_rng(7)
idx = rng.choice(len(C), min(20000, len(C)), replace=False)
pts = C[idx]
cent = pts[rng.choice(len(pts), K, replace=False)].copy()
for _ in range(14):
    d = ((pts[:, None, :] - cent[None, :, :]) ** 2).sum(-1)
    lab = d.argmin(1)
    for k in range(K):
        m = lab == k
        if m.any():
            cent[k] = pts[m].mean(0)
dist = ((C[:, None, :] - cent[None, :, :]) ** 2).sum(-1)
CL = dist.argmin(1)
log(f"k-means done, cluster sizes: {np.bincount(CL, minlength=K).tolist()}")


def cluster_material(k):
    """Name + metallic/roughness guess from the cluster's mean color."""
    c = cent[k]
    r, g, b = c
    mx, mn = max(c), min(c)
    sat = (mx - mn) / max(mx, 1e-6)
    lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
    goldish = r > 0.55 and g > 0.35 and b < g * 0.75 and sat > 0.25
    if goldish:
        return {"c": c, "m": 0.78, "r": 0.32}
    if lum < 0.16:
        return {"c": c, "m": 0.0, "r": 0.9}
    return {"c": c, "m": 0.05 if sat < 0.2 else 0.0, "r": 0.72}


# ------------------------------------------------------------ skeleton ----
# Joint positions measured from the model's height bands (see analysis):
# upright A-pose, sleeves hang near-vertical, face toward +z, robe train -z.
BONES = [
    ("root", None, (0.0, 0.0, 0.0)),
    ("hips", 0, (0.0, 0.50, 0.0)),
    ("spine", 1, (0.0, 0.10, 0.0)),
    ("chest", 2, (0.0, 0.10, 0.0)),
    ("neck", 3, (0.0, 0.12, 0.0)),
    ("head", 4, (0.0, 0.10, 0.0)),
    ("shoulder_l", 3, (0.13, 0.08, 0.0)),
    ("upper_arm_l", 6, (0.05, -0.01, 0.02)),
    ("forearm_l", 7, (0.02, -0.18, 0.0)),
    ("hand_l", 8, (0.02, -0.16, 0.0)),
    ("shoulder_r", 3, (-0.13, 0.08, 0.0)),
    ("upper_arm_r", 10, (-0.05, -0.01, 0.02)),
    ("forearm_r", 11, (-0.02, -0.18, 0.0)),
    ("hand_r", 12, (-0.02, -0.16, 0.0)),
    ("staff_hide", 12, (0.0, 0.0, 0.0)),  # offset patched once tips are known
    ("thigh_l", 1, (0.075, -0.02, 0.0)),
    ("shin_l", 14, (0.0, -0.22, 0.0)),
    ("foot_l", 15, (0.0, -0.18, 0.0)),
    ("thigh_r", 1, (-0.075, -0.02, 0.0)),
    ("shin_r", 17, (0.0, -0.22, 0.0)),
    ("foot_r", 18, (0.0, -0.18, 0.0)),
    ("tail_1", 1, (0.0, -0.02, -0.10)),
    ("tail_2", 20, (0.0, -0.12, -0.10)),
    ("tail_3", 21, (0.0, -0.12, -0.10)),
    ("scarf_1", 3, (0.0, 0.04, -0.10)),
    ("scarf_2", 23, (0.0, -0.12, -0.06)),
    ("scarf_3", 24, (0.0, -0.12, -0.06)),
]
BIDX = {name: i for i, (name, _, _) in enumerate(BONES)}

# absolute joint positions
JPOS = {}
for i, (name, parent, off) in enumerate(BONES):
    off = np.array(off) * SCALE
    JPOS[name] = off if parent is None else JPOS[BONES[parent][0]] + off

# skinning segments: bone -> its child joint (the capsule it drives)
SEG_CHILD = {
    "hips": "spine", "spine": "chest", "chest": "neck", "neck": "head",
    "shoulder_l": "upper_arm_l", "upper_arm_l": "forearm_l", "forearm_l": "hand_l",
    "shoulder_r": "upper_arm_r", "upper_arm_r": "forearm_r", "forearm_r": "hand_r",
    "thigh_l": "shin_l", "shin_l": "foot_l",
    "thigh_r": "shin_r", "shin_r": "foot_r",
    "tail_1": "tail_2", "tail_2": "tail_3",
    "scarf_1": "scarf_2", "scarf_2": "scarf_3",
}
# Arm bones drive the equipment node (the rod) through the joint chain but
# deliberately take NO skin weights: the sleeves hide the arms, and proximity
# binding drags chest/robe panels along when the arm swings, tearing the
# torso apart mid-attack. The robe stays bound to spine/chest instead.
ARM_BONES = {"shoulder_l", "upper_arm_l", "forearm_l", "hand_l",
             "shoulder_r", "upper_arm_r", "forearm_r", "hand_r"}
SEGMENTS = [(b, SEG_CHILD[b]) for b in SEG_CHILD if b not in ARM_BONES]


def seg_dist(p, a, b):
    ab = b - a
    t = np.clip(((p - a) * ab).sum(1) / max((ab * ab).sum(), 1e-9), 0, 1)
    proj = a + np.outer(t, ab)
    return np.linalg.norm(p - proj, axis=1)


# per-vertex distance to every segment
D = np.stack([seg_dist(V, JPOS[a], JPOS[b]) for a, b in SEGMENTS])  # (S, Nv)

order = D.argsort(axis=0)
s0 = order[0]
s1 = order[1]
d0 = D[s0, np.arange(len(V))]
d1 = D[s1, np.arange(len(V))]
SIGMA = 0.12 * SCALE
w1 = 1.0 / (1.0 + np.exp(-(d1 - d0) / (0.035 * SCALE)))  # smooth blend band
w0 = 1.0 - w1
W0 = np.zeros((len(V), 4))
J0 = np.zeros((len(V), 4), dtype=np.uint8)
J0[:, 0] = [BIDX[SEGMENTS[s][0]] for s in s0]
J0[:, 1] = [BIDX[SEGMENTS[s][0]] for s in s1]
W0[:, 0] = w0
W0[:, 1] = w1
log("proximity weights assigned")

# ------------------------------------------------- rigid overrides ----
y = V[:, 1]
x = V[:, 0]
z = V[:, 2]


def force(bone, mask):
    J0[mask] = 0
    W0[mask] = 0
    J0[mask, 0] = BIDX[bone]
    W0[mask, 0] = 1.0


# The golden staff is split out of the skinned body into its own equipment
# mesh parented to the hand_r bone node, so it rides the arm exactly and can
# be equipped/stowed as a unit. Tip clusters anchor a precise 3D line.
tip_r = (y > 0.90 * SCALE) & (x > 0.24 * SCALE)
tip_l = (y > 0.30 * SCALE) & (y < 0.50 * SCALE) & (x < -0.34 * SCALE)
RA = V[tip_r].mean(0) if tip_r.sum() > 5 else np.array([0.268, 0.917, -0.263]) * SCALE
RB = V[tip_l].mean(0) if tip_l.sum() > 5 else np.array([-0.368, 0.376, -0.087]) * SCALE
# The sculpt bends the rod over the shoulder: fit a smooth centerline by
# binning corridor points along the chord and averaging each bin, iterating
# three times. A straight fit misses the arc and leaves shells in the body.
def _seg_dist(P, a, b):
    ab = b - a
    tt = np.clip(((P - a) @ ab) / max(float(ab @ ab), 1e-12), 0, 1)
    return np.linalg.norm(P - (a + np.outer(tt, ab)), axis=1)
def _poly_dist(P, pts):
    best = np.full(len(P), 1e9)
    for a, b in zip(pts[:-1], pts[1:]):
        best = np.minimum(best, _seg_dist(P, a, b))
    return best
chord = RB - RA
chord_len = float(np.linalg.norm(chord))
proj = ((V - RA) @ chord) / max(chord_len * chord_len, 1e-12)
curve = [RA, RB]
for _iter in range(3):
    near = _poly_dist(V, curve) < 0.10
    bins = np.linspace(-0.08, 1.08, 13)
    pts = []
    for lo, hi in zip(bins[:-1], bins[1:]):
        sel = near & (proj >= lo) & (proj < hi)
        if sel.sum() >= 10:
            pts.append(V[sel].mean(0))
    if len(pts) >= 3:
        curve = pts
ROD = curve
# staff_hide rides at the rod midpoint: buried shells bound to it follow the
# swinging hand (no split rod) and collapse there on stow
_sh = next(i for i, b in enumerate(BONES) if b[0] == "staff_hide")
BONES[_sh] = (_sh_name := "staff_hide", BONES[_sh][1], tuple((RA + RB) / 2 - JPOS["hand_r"]))
JPOS["staff_hide"] = (RA + RB) / 2
sdl = _poly_dist(V, ROD)
staff = sdl < 0.075
log(f"staff equipment verts: {staff.sum()}")

# plumes + crown: everything above the head bone joint that is thin/high
force("head", (y > 0.98 * SCALE) & ~staff)

# feet: bottom bands, split by side
force("foot_l", (y < 0.13 * SCALE) & (x > 0.0) & (np.abs(x) < 0.16 * SCALE))
force("foot_r", (y < 0.13 * SCALE) & (x <= 0.0) & (np.abs(x) < 0.16 * SCALE))

# robe train behind: assign to tail chain by height so the hem whips
train = (z < -0.16 * SCALE) & (y < 0.55 * SCALE) & ~staff
for bone, lo, hi in [("tail_1", 0.38, 0.55), ("tail_2", 0.20, 0.38), ("tail_3", -1, 0.20)]:
    force(bone, train & (y >= lo * SCALE) & (y < hi * SCALE))

# upper cape behind shoulders: scarf chain
cape = (z < -0.10 * SCALE) & (y >= 0.55 * SCALE) & (y < 0.98 * SCALE) & ~staff
for bone, lo, hi in [("scarf_1", 0.80, 1.2), ("scarf_2", 0.66, 0.80), ("scarf_3", 0.55, 0.66)]:
    force(bone, cape & (y >= lo * SCALE) & (y < hi * SCALE))

# renormalize so every vertex's weights sum to exactly 1
W0 = np.clip(W0, 0, 1)
W0[:, 0] = np.where(W0.sum(1) <= 0, 1.0, W0[:, 0])
W0 /= W0.sum(1, keepdims=True)
log("weights normalized")

# ------------------------------------------------------- staff gear ----
# The rod rides on the hand_r bone as an equipment node (child of the bone,
# non-skinned), so every arm pose carries the whole staff rigidly and the
# equip/stow clips can scale it in and out (如意金箍棒 shrinks to a needle).
hand_world = JPOS["hand_r"]

# ---------------------------------------------------------- glTF emit ----
chunks = []
bin_len = 0
buffer_views = []
accessors = []


def add_view(data, target=None):
    global bin_len
    off = bin_len
    chunks.append(data)
    bin_len += len(data)
    pad = (4 - (len(data) % 4)) % 4
    if pad:
        chunks.append(b"\0" * pad)
        bin_len += pad
    buffer_views.append({"buffer": 0, "byteOffset": off, "byteLength": len(data), "target": target})
    return len(buffer_views) - 1


def acc(view, ctype, count, kind, target=34962, minmax=None):
    a = {"bufferView": view, "componentType": ctype, "count": count, "type": kind}
    if minmax:
        a["min"], a["max"] = minmax
    accessors.append(a)
    return len(accessors) - 1


def f32(arr):
    return arr.astype("<f4").tobytes()


def v3_acc(pos):
    view = add_view(f32(pos), 34962)
    return acc(view, 5126, len(pos), "VEC3", minmax=[pos.min(0).tolist(), pos.max(0).tolist()])


def v2_acc(uvs):
    return acc(add_view(f32(uvs), 34962), 5126, len(uvs), "VEC2")


def v4_acc(vals):
    return acc(add_view(f32(vals), 34962), 5126, len(vals), "VEC4")


def joints_acc(vals):
    return acc(add_view(vals.astype(np.uint8).tobytes(), 34962), 5121, len(vals), "VEC4")


def idx_acc(vals):
    return acc(add_view(vals.astype("<u4").tobytes(), 34963), 5125, len(vals), "SCALAR", target=34963)


# triangle-expand per cluster (each face belongs to its most common cluster)
face_cluster = np.stack([CL[F[:, 0]], CL[F[:, 1]], CL[F[:, 2]]], axis=1)
face_lab = np.apply_along_axis(lambda r: np.bincount(r, minlength=K).argmax(), 1, face_cluster)
prims = []
materials = []

# Face-level staff mask: centroid inside the bent corridor, then dilate
# across face adjacency so the sculpt's duplicated shell layers join the
# equipment instead of ghosting in the body when the rod shrinks away.
face_centroid = V[F].mean(1)
fc_d = _poly_dist(face_centroid, ROD)
face_col = C[F].mean(1)
# Take every face inside the corridor: the sculpt paints the rod in gold,
# cream, dark red and specular highlights, so no color rule captures it
# completely, and the rod is built from duplicated shells (the mesh has
# thousands of disconnected fragments), so a tight corridor leaves ghost
# layers behind. Sleeve faces caught by the wider corridor ride the hand
# bone anyway, which is where the arm wants them.
# The sculpt stacks several rod shells around the axis, so a tight corridor
# leaves ghosts behind. Take a wide tube wherever the rod is exposed beyond
# the torso silhouette (those shells are the visible rod) and a tight one
# through the body (the rod is occluded there and neighbors are anatomy).
# Corridor around the fitted centerline, then peel duplicate shells that sit
# one spacing away; the sleeve wrapping the rod is farther out and survives.
face_col = C[F].mean(1)
# The sculpt stacks the rod in duplicate shells wrapped by a cloth ribbon.
# Extract generously: seed the centerline corridor, peel along touching
# faces, then absorb every warm-toned face still hugging the line. Leaving
# rod shells in the body is unacceptable (they stay on the shoulder while
# the equipment swings away, so the staff visibly splits in two); a few
# ribbon faces riding along is harmless.
# Keep the equipment a thin tube around the centerline: the rod plus the
# ribbon wrapped on it live within ~0.12 of the axis, while the chest armor
# and plumes that TOUCH the rod sit just outside it. Adjacency-based peeling
# crawls from the rod into any anatomy that touches it (the torso rode the
# swinging hand and tore apart while walking), so growth is capped to the
# tube radius instead of following face neighbors.
# Wide tube: with the arm bones unskinned, no amount of rod capture can
# drag the torso during a swing, so the corridor can swallow every shell
# layer and the stow leaves no stub behind.
staff_face = fc_d < 0.16
from scipy.spatial import cKDTree as _kdtree
for _peel in range(12):
    eq_pts = V[F[staff_face]].reshape(-1, 3)
    tree = _kdtree(eq_pts)
    dd, _ = tree.query(face_centroid, k=1)
    grow = (dd < 0.06) & (fc_d < 0.30) & ~staff_face
    if not grow.any():
        break
    staff_face |= grow
# No hue-based absorb: the robe's warm front panel sits within 0.30 of the
# rod line and gets swallowed into the equipment, which then rides the
# swinging hand and tears the torso apart while walking.
log(f"staff faces captured: {staff_face.sum()}")


rod_face = staff_face
# Buried duplicate shells: faces hugging the tube just outside the extracted
# skin, oriented along it (armor plates and robe panels fail that test).
# Weights are applied per CORNER here, so sleeve faces sharing a vertex with
# a shell never inherit the collapse.
# No shell re-binding: chest/robe faces near the rod pass any geometric
# test eventually, and dragging them with the arm tears the torso during
# the attack swing. Buried shells stay anatomy-bound and ride the shoulder,
# which reads as the wrapping cloth.
shell_face = np.zeros(len(F), dtype=bool)
SHELL_IDX = 0
log("shell re-binding disabled")
for k in range(K):
    faces = F[(face_lab == k) & ~rod_face]
    if len(faces) == 0:
        continue
    tri_v = V[faces]          # (T,3,3)
    tri_n = N[faces]
    tri_j = J0[faces].copy()
    tri_w = W0[faces].copy()
    is_shell = shell_face[faces]
    if is_shell.any():
        tri_j[is_shell] = SHELL_IDX
        tri_w[is_shell] = np.array([1.0, 0.0, 0.0, 0.0])
    mm = cluster_material(k)
    p_pos = v3_acc(tri_v.reshape(-1, 3))
    p_nrm = v3_acc(tri_n.reshape(-1, 3))
    p_jnt = joints_acc(tri_j.reshape(-1, 4))
    p_wgt = v4_acc(tri_w.reshape(-1, 4))
    materials.append({
        "name": f"palette{k}",
        "doubleSided": True,
        "pbrMetallicRoughness": {
            "baseColorFactor": [float(cent[k][0]), float(cent[k][1]), float(cent[k][2]), 1.0],
            "metallicFactor": mm["m"],
            "roughnessFactor": mm["r"],
        },
    })
    prims.append({"attributes": {"POSITION": p_pos, "NORMAL": p_nrm,
                                 "JOINTS_0": p_jnt, "WEIGHTS_0": p_wgt},
                  "material": len(materials) - 1, "mode": 4})
log(f"geometry emitted: {len(prims)} primitives, {int(face_lab.shape[0])} faces")

# staff equipment mesh: geometry in the hand_r bone's local frame
staff_prims = []
staff_faces = F[staff_face]
staff_face_lab = face_lab[staff_face]
VS = V - hand_world  # hand_r rest offset == its world translation (no rotation)
for k in range(K):
    faces = staff_faces[staff_face_lab == k]
    if len(faces) == 0:
        continue
    tri_v = VS[faces]
    tri_n = N[faces]
    mm = cluster_material(k)
    p_pos = v3_acc(tri_v.reshape(-1, 3))
    p_nrm = v3_acc(tri_n.reshape(-1, 3))
    materials.append({
        "name": f"staff{k}",
        "doubleSided": True,
        "pbrMetallicRoughness": {
            "baseColorFactor": [float(cent[k][0]), float(cent[k][1]), float(cent[k][2]), 1.0],
            "metallicFactor": mm["m"],
            "roughnessFactor": mm["r"],
        },
    })
    staff_prims.append({"attributes": {"POSITION": p_pos, "NORMAL": p_nrm},
                        "material": len(materials) - 1, "mode": 4})
log(f"staff mesh: {len(staff_prims)} prims, {len(staff_faces)} faces")

# ground quad (unskinned)
gq = 12.0
gy = -0.02
gp = [[-gq, gy, -gq], [gq, gy, -gq], [gq, gy, gq], [-gq, gy, gq]]
gt = [0, 2, 1, 0, 3, 2]
ground_prim = {
    "attributes": {
        "POSITION": v3_acc(np.array([gp[i] for i in gt])),
        "NORMAL": v3_acc(np.tile([0.0, 1.0, 0.0], (6, 1))),
        "JOINTS_0": joints_acc(np.zeros((6, 4), dtype=np.uint8)),
        "WEIGHTS_0": v4_acc(np.tile([1.0, 0.0, 0.0, 0.0], (6, 1))),
    },
    "material": len(materials),
    "mode": 4,
}
materials.append({"name": "ground", "doubleSided": True,
                  "pbrMetallicRoughness": {"baseColorFactor": [0.16, 0.19, 0.24, 1.0],
                                           "metallicFactor": 0.0, "roughnessFactor": 0.95}})

# ---------------------------------------------------------- animations ----
DEG = np.pi / 180


def axis_q(axis, deg):
    s = np.sin(deg * DEG / 2)
    q = np.array([axis[0] * s, axis[1] * s, axis[2] * s, np.cos(deg * DEG / 2)])
    return (q / np.linalg.norm(q)).tolist()


RX = lambda d: axis_q([1, 0, 0], d)
RY = lambda d: axis_q([0, 1, 0], d)
RZ = lambda d: axis_q([0, 0, 1], d)
IDQ = [0.0, 0.0, 0.0, 1.0]


def mulq(a, b):
    aw, ax, ay, az = a[3], a[0], a[1], a[2]
    bw, bx, by, bz = b[3], b[0], b[1], b[2]
    return [
        aw * bx + ax * bw + ay * bz - az * by,
        aw * by - ax * bz + ay * bw + az * bx,
        aw * bz + ax * by - ay * bx + az * bw,
        aw * bw - ax * bx - ay * by - az * bz,
    ]


clips = []
HIP_REST = list(np.array(BONES[1][2]) * SCALE)


def clip(name, chans):
    clips.append({"name": name, "channels": chans})


def rot_chan(bone, keys):
    ts = np.array([[t] for t, _ in keys], dtype=np.float64)
    qs = np.array([q for _, q in keys])
    t_acc = acc(add_view(f32(ts), 34962), 5126, len(ts), "SCALAR")
    q_acc = v4_acc(qs)
    return {"bone": bone, "path": "rotation", "input": t_acc, "output": q_acc}


def trans_chan(bone, keys):
    ts = np.array([[t] for t, _ in keys], dtype=np.float64)
    vs = np.array([v for _, v in keys])
    t_acc = acc(add_view(f32(ts), 34962), 5126, len(ts), "SCALAR")
    v_acc = v3_acc(vs)
    return {"bone": bone, "path": "translation", "input": t_acc, "output": v_acc}


def walk_run(name, dur, legA, kneeA, armA, lean, bob):
    t = lambda f: f * dur
    chans = [
        rot_chan("thigh_l", [(t(0), RX(-legA)), (t(.25), RX(0)), (t(.5), RX(legA)), (t(.75), RX(0)), (t(1), RX(-legA))]),
        rot_chan("thigh_r", [(t(0), RX(legA)), (t(.25), RX(0)), (t(.5), RX(-legA)), (t(.75), RX(0)), (t(1), RX(legA))]),
        rot_chan("shin_l", [(t(0), RX(0)), (t(.25), RX(kneeA * .5)), (t(.5), RX(0)), (t(.75), RX(kneeA)), (t(1), RX(0))]),
        rot_chan("shin_r", [(t(0), RX(0)), (t(.25), RX(kneeA)), (t(.5), RX(0)), (t(.75), RX(kneeA * .5)), (t(1), RX(0))]),
        rot_chan("upper_arm_l", [(t(0), RY(armA)), (t(.5), RY(-armA)), (t(1), RY(armA))]),
        rot_chan("upper_arm_r", [(t(0), RY(armA * .18)), (t(.5), RY(-armA * .18)), (t(1), RY(armA * .18))]),
        rot_chan("forearm_l", [(t(0), RX(-10)), (t(.5), RX(-20)), (t(1), RX(-10))]),
        rot_chan("spine", [(0, RX(-lean)), (t(1), RX(-lean))]),
        rot_chan("tail_1", [(t(0), RY(10)), (t(.5), RY(-10)), (t(1), RY(10))]),
        rot_chan("tail_2", [(t(0), RY(14)), (t(.5), RY(-14)), (t(1), RY(14))]),
        rot_chan("tail_3", [(t(0), RY(18)), (t(.5), RY(-18)), (t(1), RY(18))]),
        rot_chan("scarf_1", [(t(0), RX(12)), (t(.5), RX(2)), (t(1), RX(12))]),
        rot_chan("scarf_2", [(t(0), RX(18)), (t(.5), RX(4)), (t(1), RX(18))]),
        rot_chan("scarf_3", [(t(0), RX(24)), (t(.5), RX(6)), (t(1), RX(24))]),
        trans_chan("hips", [(t(0), HIP_REST), (t(.25), [HIP_REST[0], HIP_REST[1] + bob, HIP_REST[2]]),
                            (t(.5), HIP_REST), (t(.75), [HIP_REST[0], HIP_REST[1] + bob, HIP_REST[2]]), (t(1), HIP_REST)]),
    ]
    clip(name, chans)


clip("idle", [
    rot_chan("upper_arm_l", [(0, RY(4)), (1.2, RY(-4)), (2.4, RY(4))]),
    rot_chan("upper_arm_r", [(0, RY(-4)), (1.2, RY(4)), (2.4, RY(-4))]),
    rot_chan("spine", [(0, RX(2)), (1.2, RX(-2)), (2.4, RX(2))]),
    rot_chan("head", [(0, RY(-5)), (1.2, RY(5)), (2.4, RY(-5))]),
    rot_chan("tail_1", [(0, RY(8)), (.8, RY(-8)), (1.6, RY(8)), (2.4, RY(-8))]),
    rot_chan("tail_2", [(0, RY(-12)), (.8, RY(12)), (1.6, RY(-12)), (2.4, RY(12))]),
    rot_chan("tail_3", [(0, RY(16)), (.8, RY(-16)), (1.6, RY(16)), (2.4, RY(-16))]),
    rot_chan("scarf_1", [(0, RX(6)), (1.2, RX(12)), (2.4, RX(6))]),
    rot_chan("scarf_2", [(0, RX(10)), (1.2, RX(18)), (2.4, RX(10))]),
    rot_chan("scarf_3", [(0, RX(14)), (1.2, RX(24)), (2.4, RX(14))]),
    trans_chan("hips", [(0, HIP_REST), (1.2, [HIP_REST[0], HIP_REST[1] + .012, HIP_REST[2]]), (2.4, HIP_REST)]),
])
walk_run("walk", 0.8, 24, 36, 16, 5, .015)
walk_run("run", 0.5, 40, 60, 30, 12, .03)
clip("jump", [
    trans_chan("hips", [(0, HIP_REST), (.15, [HIP_REST[0], HIP_REST[1] - .06, HIP_REST[2]]),
                        (.3, [HIP_REST[0], HIP_REST[1] + .03, HIP_REST[2]]),
                        (.45, [HIP_REST[0], HIP_REST[1] + .03, HIP_REST[2]]),
                        (.6, [HIP_REST[0], HIP_REST[1] - .05, HIP_REST[2]]), (.75, HIP_REST)]),
    rot_chan("thigh_l", [(0, RX(0)), (.15, RX(-30)), (.3, RX(-50)), (.45, RX(-15)), (.6, RX(-35)), (.75, RX(0))]),
    rot_chan("thigh_r", [(0, RX(0)), (.15, RX(-30)), (.3, RX(-40)), (.45, RX(-8)), (.6, RX(-30)), (.75, RX(0))]),
    rot_chan("shin_l", [(0, RX(0)), (.15, RX(65)), (.3, RX(55)), (.45, RX(8)), (.6, RX(55)), (.75, RX(0))]),
    rot_chan("shin_r", [(0, RX(0)), (.15, RX(65)), (.3, RX(45)), (.45, RX(4)), (.6, RX(50)), (.75, RX(0))]),
    rot_chan("upper_arm_l", [(0, IDQ), (.3, RZ(45)), (.45, RZ(60)), (.75, IDQ)]),
    rot_chan("upper_arm_r", [(0, IDQ), (.3, RZ(-6)), (.45, RZ(-8)), (.75, IDQ)]),
    rot_chan("spine", [(0, RX(0)), (.15, RX(-16)), (.3, RX(6)), (.6, RX(-12)), (.75, RX(0))]),
    rot_chan("tail_1", [(0, IDQ), (.3, RX(-22)), (.6, RX(-12)), (.75, IDQ)]),
    rot_chan("tail_2", [(0, IDQ), (.3, RX(-28)), (.6, RX(-16)), (.75, IDQ)]),
    rot_chan("tail_3", [(0, IDQ), (.3, RX(-34)), (.6, RX(-20)), (.75, IDQ)]),
    rot_chan("scarf_1", [(0, IDQ), (.3, RX(-28)), (.75, IDQ)]),
    rot_chan("scarf_2", [(0, IDQ), (.3, RX(-38)), (.75, IDQ)]),
    rot_chan("scarf_3", [(0, IDQ), (.3, RX(-48)), (.75, IDQ)]),
])
clip("attack", [
    # wind-up: torso coils right, staff hand draws back; strike: everything
    # whips left through the body so the rod sweeps a wide horizontal arc.
    rot_chan("upper_arm_r", [(0, IDQ), (.22, mulq(RY(55), RZ(-52))), (.40, mulq(RY(-95), RZ(-62))),
                             (.58, mulq(RY(-45), RZ(-30))), (.9, IDQ)]),
    rot_chan("forearm_r", [(0, IDQ), (.22, RZ(18)), (.40, RZ(-14)), (.58, RZ(-8)), (.9, IDQ)]),
    rot_chan("spine", [(0, IDQ), (.22, mulq(RX(-4), RY(26))), (.40, mulq(RX(-8), RY(-36))),
                       (.58, RY(-18)), (.9, IDQ)]),
    rot_chan("upper_arm_l", [(0, IDQ), (.22, RY(-35)), (.40, RY(30)), (.58, RY(14)), (.9, IDQ)]),
    rot_chan("head", [(0, IDQ), (.22, RY(10)), (.40, RY(-12)), (.58, RY(-6)), (.9, IDQ)]),
    rot_chan("thigh_r", [(0, RX(0)), (.4, RX(-12)), (.6, RX(-6)), (.9, RX(0))]),
    rot_chan("shin_r", [(0, RX(0)), (.4, RX(16)), (.6, RX(8)), (.9, RX(0))]),
    rot_chan("tail_1", [(0, IDQ), (.3, RX(-18)), (.9, IDQ)]),
    rot_chan("tail_2", [(0, IDQ), (.3, RX(-24)), (.9, IDQ)]),
    rot_chan("tail_3", [(0, IDQ), (.3, RX(-30)), (.9, IDQ)]),
    rot_chan("scarf_1", [(0, IDQ), (.35, RX(-22)), (.9, IDQ)]),
    rot_chan("scarf_2", [(0, IDQ), (.35, RX(-32)), (.9, IDQ)]),
    rot_chan("scarf_3", [(0, IDQ), (.35, RX(-42)), (.9, IDQ)]),
    trans_chan("hips", [(0, HIP_REST), (.2, [HIP_REST[0], HIP_REST[1] - .02, HIP_REST[2]]),
                        (.4, [HIP_REST[0], HIP_REST[1] - .01, HIP_REST[2] + .05]),
                        (.6, [HIP_REST[0], HIP_REST[1], HIP_REST[2] + .02]), (.9, HIP_REST)]),
])

def scale_chan(node_index, keys):
    ts = np.array([[t] for t, _ in keys], dtype=np.float64)
    vs = np.array([v for _, v in keys])
    t_acc = acc(add_view(f32(ts), 34962), 5126, len(ts), "SCALAR")
    v_acc = v3_acc(vs)
    return {"node": node_index, "path": "translation", "input": t_acc, "output": v_acc}


# equip/stow are emitted after nodes exist (see assemble); stash keyframes.
EQUIP_KEYS = [(0.0, [0.0, 0.0, 0.0]), (0.12, [0.16, 0.16, 0.16]),
              (0.30, [1.0, 1.0, 1.0]), (0.55, [1.0, 1.0, 1.0])]
STOW_KEYS = [(0.0, [1.0, 1.0, 1.0]), (0.25, [1.0, 1.0, 1.0]),
             (0.42, [0.16, 0.16, 0.16]), (0.55, [0.0, 0.0, 0.0])]

# ------------------------------------------------------------- assemble ----
nodes = []
for i, (name, parent, off) in enumerate(BONES):
    kids = [j for j, (_, p, _) in enumerate(BONES) if p == i]
    node = {"name": name, "translation": (np.array(off) * SCALE).tolist()}
    if kids:
        node["children"] = kids
    nodes.append(node)
staff_idx = len(nodes)
nodes.append({"name": "staff_gear", "mesh": 1})
nodes[BIDX["hand_r"]]["children"] = nodes[BIDX["hand_r"]].get("children", []) + [staff_idx]
char_idx = len(nodes)
nodes.append({"name": "wukong", "mesh": 0, "skin": 0, "children": [0]})
ground_idx = len(nodes)
nodes.append({"name": "ground", "mesh": 2})

# inverse bind matrices: world rest transforms are pure translations
inv_bind = []
acc_world = {}
for i, (name, parent, off) in enumerate(BONES):
    off = np.array(off) * SCALE
    acc_world[name] = off if parent is None else acc_world[BONES[parent][0]] + off
for name, _, _ in BONES:
    t = acc_world[name]
    # column-major mat4 of translate(-t)
    inv_bind.append([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -t[0], -t[1], -t[2], 1])
ib_view = add_view(f32(np.array(inv_bind, dtype=np.float64)))
ib_acc = acc(ib_view, 5126, len(inv_bind), "MAT4", target=None)

animations = []
for c in clips:
    chans, samps = [], []
    for ch in c["channels"]:
        samps.append({"input": ch["input"], "interpolation": "LINEAR", "output": ch["output"]})
        node_index = staff_idx if ch["bone"] == "__staff__" else BIDX[ch["bone"]]
        chans.append({"sampler": len(samps) - 1,
                      "target": {"node": node_index, "path": ch["path"]}})
    animations.append({"name": c["name"], "channels": chans, "samplers": samps})

# equip / stow: scale the equipment node AND the staff_hide bone together,
# so the rod and its buried ghost shells shrink into the fist as one piece
for clip_name, keys in [("equip", EQUIP_KEYS), ("stow", STOW_KEYS)]:
    ts = np.array([[t] for t, _ in keys], dtype=np.float64)
    vs = np.array([v for _, v in keys])
    t_acc = acc(add_view(f32(ts), 34962), 5126, len(ts), "SCALAR")
    v_acc = v3_acc(vs)
    animations.append({
        "name": clip_name,
        "channels": [
            {"sampler": 0, "target": {"node": staff_idx, "path": "scale"}},
            {"sampler": 0, "target": {"node": BIDX["staff_hide"], "path": "scale"}},
        ],
        "samplers": [{"input": t_acc, "interpolation": "LINEAR", "output": v_acc}],
    })

buffer = b"".join(chunks)
doc = {
    "asset": {"version": "2.0", "generator": "rig_wukong.py"},
    "scene": 0,
    "scenes": [{"name": "wukong_scene", "nodes": [char_idx, ground_idx]}],
    "nodes": nodes,
    "skins": [{"name": "wukong_skin", "joints": list(range(len(BONES))), "skeleton": 0,
               "inverseBindMatrices": ib_acc}],
    "meshes": [{"name": "wukong_body", "primitives": prims},
               {"name": "staff", "primitives": staff_prims},
               {"name": "ground", "primitives": [ground_prim]}],
    "materials": materials,
    "animations": animations,
    "accessors": accessors,
    "bufferViews": buffer_views,
    "buffers": [{"byteLength": len(buffer),
                 "uri": "data:application/octet-stream;base64," + base64.b64encode(buffer).decode()}],
}
with open(DST, "w") as fh:
    json.dump(doc, fh)
log(f"wrote {DST}: {len(prims)} prims, {len(buffer)} bytes buffer")
