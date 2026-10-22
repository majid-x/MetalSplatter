"""
photo_api.py  -  splat -> source photo lookup
Projection-based visibility with point-cloud occlusion (no pre-built index needed).

Auto-detects two dataset layouts:

  A) Parker (pinhole EXR):
       <root>/                  <- EXR photos + this file
       <root>/colmap/colmap/    <- cameras.txt / images.txt / points3D.txt

  B) Harut (360 equirectangular, binary COLMAP):
       <root>/                  <- this file
       <root>/images/<sub>/*.jpg
       <root>/colmap/colmap/    <- cameras.bin / images.bin / points3D.bin

COLMAP files may be binary (.bin) or text (.txt); camera model may be pinhole or
equirectangular (model 17). Images may be EXR or JPG/PNG in nested subfolders.
"""

import os, re, json, base64, logging, struct
from typing import Optional, List

os.environ["OPENCV_IO_ENABLE_OPENEXR"] = "1"  # must be before cv2 import

import numpy as np
try:
    from scipy.spatial import KDTree
    _HAS_SCIPY = True
except ImportError:
    _HAS_SCIPY = False

import cv2
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, RedirectResponse, FileResponse
from pydantic import BaseModel
import uvicorn

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("photo_api")

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def _find_colmap_dir():
    env = os.environ.get("PHOTO_API_COLMAP_DIR")
    candidates = [env] if env else []
    candidates += [
        os.path.join(BASE_DIR, "colmap", "colmap"),
        os.path.join(BASE_DIR, "colmap"),
        BASE_DIR,
    ]
    for d in candidates:
        if not d:
            continue
        if os.path.isfile(os.path.join(d, "cameras.txt")) or os.path.isfile(
            os.path.join(d, "cameras.bin")
        ):
            return d
    return os.path.join(BASE_DIR, "colmap", "colmap")


COLMAP_DIR = _find_colmap_dir()


def _find_images_dir():
    env = os.environ.get("PHOTO_API_IMAGES_DIR")
    if env:
        return env
    # Prefer an images/ subfolder (this dataset), else the script dir (Parker EXRs).
    cand = os.path.join(BASE_DIR, "images")
    return cand if os.path.isdir(cand) else BASE_DIR


IMAGES_DIR = _find_images_dir()
OUTPUT_DIR = os.path.join(BASE_DIR, "photo_results")
CAL_FILE = os.path.join(COLMAP_DIR, "calibration.json")
os.makedirs(OUTPUT_DIR, exist_ok=True)
log.info(f"COLMAP_DIR={COLMAP_DIR}")
log.info(f"IMAGES_DIR={IMAGES_DIR}")

# ---------------------------------------------------------------------------
# Global state
# ---------------------------------------------------------------------------
cameras        = {}
images         = {}
points         = None
_point_colors  = None
kdtree         = None

_image_file_map = {}
_cal_pairs      = []
_cal_transform  = None

_img_ids      = []
_Rs           = None
_ts           = None
_world_pos    = None
_cam_params   = None
_cam_equirect = None   # per-image bool: True if its camera is a 360 equirectangular

# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------
def quat_to_R(qw, qx, qy, qz):
    return np.array([
        [1-2*(qy**2+qz**2), 2*(qx*qy-qz*qw), 2*(qx*qz+qy*qw)],
        [2*(qx*qy+qz*qw),   1-2*(qx**2+qz**2), 2*(qy*qz-qx*qw)],
        [2*(qx*qz-qy*qw),   2*(qy*qz+qx*qw),   1-2*(qx**2+qy**2)]
    ])

_IMG_EXTS = (".jpg", ".jpeg", ".png", ".exr", ".tif", ".tiff", ".bmp", ".webp")

def _build_image_file_map():
    """Index every image under IMAGES_DIR (recursively, including subfolders) by its
    path relative to IMAGES_DIR and by basename, so COLMAP names like
    'Untitled11/00014.jpg' or Parker's EXR stems both resolve."""
    global _image_file_map
    _image_file_map = {}
    for root, _dirs, files in os.walk(IMAGES_DIR):
        for fname in files:
            if not fname.lower().endswith(_IMG_EXTS):
                continue
            full = os.path.join(root, fname)
            rel  = os.path.relpath(full, IMAGES_DIR).replace("\\", "/").lower()
            _image_file_map[rel] = full                                   # by rel path
            _image_file_map.setdefault(os.path.splitext(rel)[0], full)     # rel, no ext
            _image_file_map.setdefault(fname.lower(), full)                # by basename
            _image_file_map.setdefault(os.path.splitext(fname)[0].lower(), full)
    log.info(f"Image files indexed: {len(_image_file_map)} under {IMAGES_DIR}")

def _resolve_image(colmap_name: str) -> Optional[str]:
    """Map a COLMAP image name to a file on disk. Handles both this dataset's
    'subfolder/frame.jpg' names (a direct path under images/) and Parker's
    '...mp4#NNNNN' -> EXR scheme (via _resolve_exr fallback)."""
    name = colmap_name.replace("\\", "/").strip()
    direct = os.path.join(IMAGES_DIR, name)
    if os.path.isfile(direct):
        return direct
    base = name.split("/")[-1]
    for key in (name.lower(), os.path.splitext(name.lower())[0],
                base.lower(), os.path.splitext(base.lower())[0]):
        if key in _image_file_map:
            return _image_file_map[key]
    return _resolve_exr(colmap_name)

def _resolve_exr(colmap_name: str) -> Optional[str]:
    """Legacy Parker naming: 'C:\\...\\parker(1).mp4#00018' -> 'parker(1)0018.exr'."""
    name     = colmap_name.replace("\\", "/")
    basename = name.split("/")[-1]
    m = re.search(r"#(\d+)$", basename)
    if not m:
        return None
    num = int(m.group(1))
    vid = re.sub(r"\.mp4#\d+$", "", basename, flags=re.IGNORECASE)
    candidates = [
        re.sub(r"[Vv]\+\d+$",  f"V+{num:04d}", vid),
        re.sub(r"[Vv]-\d+$",   f"V-{num:04d}", vid),
        re.sub(r"[Vv]0{2,3}$", f"V{num:04d}",  vid),
        f"{vid}{num:04d}",
        f"{vid}{num}",
    ]
    for c in candidates:
        key = c.lower()
        if key in _image_file_map:
            return _image_file_map[key]
    return None

# ---------------------------------------------------------------------------
# COLMAP loaders  (auto-detect binary .bin or text .txt)
# ---------------------------------------------------------------------------
# COLMAP camera model_id -> number of parameters. Model 17 is a 360 equirectangular
# camera (params = [width, height], no focal length) as used by this dataset.
_CAM_MODEL_NPARAMS = {0:3, 1:4, 2:4, 3:5, 4:8, 5:8, 6:12, 7:5, 8:4, 9:5, 10:12, 17:2}
EQUIRECT_MODEL_IDS = {17}

def _cam_record(model_id, w, h, params):
    """Normalise any COLMAP camera model into our internal dict, flagging 360s."""
    p = list(params)
    if model_id in EQUIRECT_MODEL_IDS or len(p) < 3:
        return dict(w=w, h=h, equirect=True,
                    fx=0.0, fy=0.0, cx=w / 2.0, cy=h / 2.0, dist=[])
    if model_id == 1:                       # PINHOLE: fx fy cx cy
        fx, fy, cx, cy = p[0], p[1], p[2], p[3]
    elif model_id in (0, 2, 3, 8, 9):       # *_PINHOLE / *_RADIAL: f cx cy [k...]
        fx = fy = p[0]; cx, cy = p[1], p[2]
    else:                                   # OPENCV / FULL_OPENCV / ...: fx fy cx cy ...
        fx, fy, cx, cy = p[0], p[1], p[2], p[3]
    return dict(w=w, h=h, equirect=False, fx=fx, fy=fy, cx=cx, cy=cy, dist=p[4:12])

def _load_cameras():
    global cameras
    cameras = {}
    binp = os.path.join(COLMAP_DIR, "cameras.bin")
    if os.path.isfile(binp):
        with open(binp, "rb") as f:
            n = struct.unpack("<Q", f.read(8))[0]
            for _ in range(n):
                cam_id, model_id = struct.unpack("<ii", f.read(8))
                w, h = struct.unpack("<QQ", f.read(16))
                npar = _CAM_MODEL_NPARAMS.get(model_id, 4)
                params = struct.unpack("<%dd" % npar, f.read(8 * npar))
                cameras[cam_id] = _cam_record(model_id, int(w), int(h), params)
    else:
        with open(os.path.join(COLMAP_DIR, "cameras.txt"), encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                parts = line.split()
                if len(parts) < 5:
                    continue
                cid = int(parts[0])
                w, h = int(parts[2]), int(parts[3])
                params = [float(p) for p in parts[4:]]
                # Map the text model name to an id where it matters (equirect vs pinhole).
                model_name = parts[1].upper()
                if model_name in ("EQUIRECTANGULAR", "SPHERE", "SPHERICAL") or len(params) < 3:
                    cameras[cid] = _cam_record(17, w, h, params)
                else:
                    cameras[cid] = dict(w=w, h=h, equirect=False,
                                        fx=params[0], fy=params[1] if len(params) > 1 else params[0],
                                        cx=params[2] if len(params) > 2 else w/2.0,
                                        cy=params[3] if len(params) > 3 else h/2.0,
                                        dist=params[4:12])
    n_eq = sum(1 for c in cameras.values() if c.get("equirect"))
    log.info(f"Cameras loaded: {len(cameras)} (equirectangular: {n_eq})")

def _load_images():
    global images
    images = {}
    ok = fail = 0
    binp = os.path.join(COLMAP_DIR, "images.bin")
    if os.path.isfile(binp):
        with open(binp, "rb") as f:
            n = struct.unpack("<Q", f.read(8))[0]
            for _ in range(n):
                img_id = struct.unpack("<i", f.read(4))[0]
                qw, qx, qy, qz = struct.unpack("<4d", f.read(32))
                tx, ty, tz     = struct.unpack("<3d", f.read(24))
                cam_id = struct.unpack("<i", f.read(4))[0]
                nb = bytearray()
                while True:
                    c = f.read(1)
                    if c == b"\x00" or c == b"":
                        break
                    nb += c
                name = nb.decode("utf-8", "replace")
                npts = struct.unpack("<Q", f.read(8))[0]
                f.seek(npts * 24, 1)          # skip 2D points (x,y double + id int64)
                R = quat_to_R(qw, qx, qy, qz); t = np.array([tx, ty, tz])
                path = _resolve_image(name)
                if path: ok += 1
                else:    fail += 1
                images[img_id] = dict(name=name, exr_path=path,
                                      R=R, t=t, world_pos=-R.T @ t, cam_id=cam_id)
    else:
        with open(os.path.join(COLMAP_DIR, "images.txt"), encoding="utf-8", errors="replace") as f:
            lines = [l.rstrip("\r\n") for l in f]
        i = 0
        while i < len(lines):
            line = lines[i]; i += 1
            if not line or line.startswith("#"):
                continue
            parts = line.split(None, 9)
            if len(parts) < 9:
                i += 1
                continue
            img_id = int(parts[0])
            qw,qx,qy,qz = float(parts[1]),float(parts[2]),float(parts[3]),float(parts[4])
            tx,ty,tz     = float(parts[5]),float(parts[6]),float(parts[7])
            cam_id = int(parts[8])
            name   = parts[9].strip() if len(parts) > 9 else ""
            R = quat_to_R(qw,qx,qy,qz); t = np.array([tx,ty,tz])
            path = _resolve_image(name)
            if path: ok += 1
            else:    fail += 1
            images[img_id] = dict(name=name, exr_path=path,
                                   R=R, t=t, world_pos=-R.T@t, cam_id=cam_id)
            i += 1
    log.info(f"Images loaded: {len(images)}  resolve ok={ok} fail={fail}")

def _load_points():
    global points, _point_colors, kdtree
    binp = os.path.join(COLMAP_DIR, "points3D.bin")
    if os.path.isfile(binp):
        buf = open(binp, "rb").read()
        M = struct.unpack_from("<Q", buf, 0)[0]
        pts  = np.empty((M, 3), dtype=np.float32)
        cols = np.empty((M, 3), dtype=np.uint8)
        off = 8
        for i in range(M):
            # id(8) x,y,z(24) rgb(3) error(8) track_len(8) then track_len*(image_id int32, pt2d_idx uint32)=8
            x, y, z = struct.unpack_from("<3d", buf, off + 8)
            r, g, b = struct.unpack_from("<3B", buf, off + 32)
            tl = struct.unpack_from("<Q", buf, off + 43)[0]
            pts[i]  = (x, y, z)
            cols[i] = (r, g, b)
            off += 51 + tl * 8
        points, _point_colors = pts, cols
    else:
        pts, cols = [], []
        with open(os.path.join(COLMAP_DIR, "points3D.txt"), encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                parts = line.split()
                if len(parts) >= 7:
                    pts.append([float(parts[1]), float(parts[2]), float(parts[3])])
                    cols.append([int(parts[4]), int(parts[5]), int(parts[6])])
                elif len(parts) >= 4:
                    pts.append([float(parts[1]), float(parts[2]), float(parts[3])])
                    cols.append([180, 180, 180])
        points        = np.array(pts,  dtype=np.float32)
        _point_colors = np.array(cols, dtype=np.uint8)
    if _HAS_SCIPY:
        kdtree = KDTree(points)
        log.info(f"Points: {len(points)}, scipy KD-tree built")
    else:
        log.info(f"Points: {len(points)}, brute-force NN")

def _nearest_point(query):
    if _HAS_SCIPY and kdtree is not None:
        return kdtree.query(query)
    diffs = points - query
    dists = np.einsum("ij,ij->i", diffs, diffs)
    idx   = int(np.argmin(dists))
    return float(np.sqrt(dists[idx])), idx

def _build_camera_arrays():
    global _img_ids, _Rs, _ts, _world_pos, _cam_params, _cam_equirect
    _img_ids    = list(images.keys())
    _Rs         = np.stack([images[i]["R"]         for i in _img_ids])
    _ts         = np.stack([images[i]["t"]         for i in _img_ids])
    _world_pos  = np.stack([images[i]["world_pos"] for i in _img_ids])
    C = [cameras[images[i]["cam_id"]] for i in _img_ids]
    _cam_params = np.array(
        [[c["fx"], c["fy"], c["cx"], c["cy"], c["w"], c["h"]] for c in C],
        dtype=np.float64)
    _cam_equirect = np.array([bool(c.get("equirect", False)) for c in C], dtype=bool)
    log.info(f"Camera arrays built: {len(_img_ids)} (equirect: {int(_cam_equirect.sum())})")

# ---------------------------------------------------------------------------
# Calibration
# ---------------------------------------------------------------------------
def _load_calibration():
    global _cal_pairs, _cal_transform
    if os.path.exists(CAL_FILE):
        try:
            d = json.loads(open(CAL_FILE).read())
            _cal_pairs     = d.get("pairs", [])
            _cal_transform = d.get("transform", None)
            log.info(f"Calibration: {len(_cal_pairs)} pairs, active={_cal_transform is not None}")
        except Exception as e:
            log.warning(f"Calibration load failed: {e}")

def _save_calibration():
    open(CAL_FILE, "w").write(json.dumps({"pairs": _cal_pairs, "transform": _cal_transform}, indent=2))

def _compute_transform(pairs):
    if len(pairs) < 3:
        return None
    S = np.array([p["splat"]  for p in pairs], dtype=float)
    C = np.array([p["colmap"] for p in pairs], dtype=float)
    s_mean, c_mean = S.mean(0), C.mean(0)
    ds, dc = S - s_mean, C - c_mean
    scale  = np.sqrt((dc**2).sum() / max((ds**2).sum(), 1e-12))
    H      = ds.T @ dc
    U,_,Vt = np.linalg.svd(H)
    R = Vt.T @ U.T
    if np.linalg.det(R) < 0:
        Vt[-1] *= -1; R = Vt.T @ U.T
    t = c_mean - scale * R @ s_mean
    residuals = []
    for p in pairs:
        pred = scale * R @ np.array(p["splat"]) + t
        residuals.append({"label": p.get("label",""), "error": float(np.linalg.norm(pred - np.array(p["colmap"])))})
    return {"R": R.tolist(), "t": t.tolist(), "scale": float(scale),
            "method": f"procrustes_{len(pairs)}pt", "residuals": residuals,
            "mean_error": float(np.mean([r["error"] for r in residuals]))}

def _apply_transform(x, y, z):
    if _cal_transform is None:
        return x, y, z
    R = np.array(_cal_transform["R"])
    t = np.array(_cal_transform["t"])
    s = _cal_transform["scale"]
    r = s * R @ np.array([x, y, z]) + t
    return float(r[0]), float(r[1]), float(r[2])

# ---------------------------------------------------------------------------
# Point-cloud ray-occlusion test
# ---------------------------------------------------------------------------
# COLMAP exported this reconstruction with empty tracks (mean track length 0),
# so there is no ground-truth per-point visibility to rely on. Instead we use the
# 552k-point cloud itself as a geometry proxy: for each candidate camera we march
# along the sight-line from the camera to the clicked surface point and check
# whether solid geometry (a dense cluster of cloud points) blocks the way. A
# camera behind a wall has the wall's points sitting on its sight-line and is
# dropped; a camera with a clear line keeps its view. This removes the
# "photo taken from the far side of a wall" results that pure projection returns.
#
# A sample counts as "solid" only if it sits inside a dense cluster (a real
# surface), not next to one or two stray floaters — measured on this cloud,
# genuine surfaces hold ~40 points within 5 cm while open air holds 0-3, giving a
# clean separation at ~12. The region right at the target surface (far_margin)
# and right at the camera (near_margin) is skipped so the target's own surface can
# never count as its occluder.
OCC_RADIUS       = 0.05   # metres: neighbourhood radius for the density test
OCC_STEP         = 0.06   # metres: spacing of samples along the sight-line
OCC_NEAR_MARGIN  = 0.25   # metres: skip this much of the ray next to the camera
OCC_FAR_MARGIN   = 0.22   # metres: skip this much of the ray next to the surface
OCC_SOLID_DENSITY = 12    # cloud points within OCC_RADIUS to call a sample "solid"
OCC_MIN_HITS     = 1      # solid samples needed to declare the ray occluded

OCC_BUILD = "v4-equirect-binary"   # bump when this logic changes; shown in /health so you
                             # can confirm the running server picked up new code.
_occ_stats = {}              # diagnostics from the last occlusion run


def _ball_counts(sample_pts, radius):
    """Number of cloud points within `radius` of each sample (vectorised)."""
    if _HAS_SCIPY and kdtree is not None:
        try:
            return np.asarray(
                kdtree.query_ball_point(sample_pts, radius,
                                        return_length=True, workers=-1)
            )
        except TypeError:
            # Older scipy without return_length/workers: fall back to list output.
            nbrs = kdtree.query_ball_point(sample_pts, radius)
            return np.array([len(n) for n in nbrs])
    # No scipy: brute force (only used if the KD-tree is unavailable).
    counts = np.empty(len(sample_pts), dtype=np.int64)
    for i, s in enumerate(sample_pts):
        diffs = points - s
        counts[i] = int(np.count_nonzero(np.einsum("ij,ij->i", diffs, diffs) <= radius * radius))
    return counts


def _occluded_mask(cam_positions, pt,
                   occ_radius=OCC_RADIUS, step=OCC_STEP,
                   near_margin=OCC_NEAR_MARGIN, far_margin=OCC_FAR_MARGIN,
                   solid_density=OCC_SOLID_DENSITY, min_hits=OCC_MIN_HITS):
    """Boolean array: True where the camera's line of sight to `pt` is blocked.

    All candidate sight-lines are sampled and their neighbourhood densities are
    computed in a single KD-tree call, then reduced per camera.
    """
    K = len(cam_positions)
    occ = np.zeros(K, dtype=bool)
    if K == 0 or points is None or len(points) == 0:
        return occ

    seg_ids   = []          # which camera each stacked sample belongs to
    all_samps = []          # stacked sample positions for one big KD-tree query
    for k in range(K):
        cam = cam_positions[k]
        d   = pt - cam
        L   = float(np.linalg.norm(d))
        if L <= near_margin + far_margin:
            continue
        dirv = d / L
        ts   = np.arange(near_margin, L - far_margin, step)
        if ts.size == 0:
            continue
        samps = cam[None, :] + ts[:, None] * dirv[None, :]
        all_samps.append(samps)
        seg_ids.append(np.full(samps.shape[0], k, dtype=np.int64))

    if not all_samps:
        return occ

    all_samps = np.concatenate(all_samps, axis=0)
    seg_ids   = np.concatenate(seg_ids, axis=0)
    counts    = _ball_counts(all_samps, occ_radius)
    solid     = counts >= solid_density
    if not solid.any():
        return occ
    # Sum solid samples per camera; occluded if it reaches min_hits.
    hits = np.bincount(seg_ids[solid], minlength=K)
    occ  = hits >= min_hits
    return occ


def _estimate_normal(pt, k=40, orient_toward=None):
    """Local surface normal at `pt` via PCA of its k nearest cloud points.
    The normal is sign-ambiguous, so orient it toward `orient_toward` (typically
    the mean camera position) so "front" means the side the cameras are on.
    Returns a unit vector, or None if it can't be estimated."""
    if points is None or len(points) < k:
        return None
    if _HAS_SCIPY and kdtree is not None:
        _, idx = kdtree.query(pt, k=k)
        idx = np.asarray(idx)
    else:
        d = np.einsum("ij,ij->i", points - pt, points - pt)
        idx = np.argpartition(d, k)[:k]
    nn = points[idx].astype(np.float64)
    c = nn - nn.mean(axis=0)
    w, ax = np.linalg.eigh(c.T @ c)
    n = ax[:, 0]                       # eigenvector of smallest eigenvalue = normal
    if orient_toward is not None:
        if np.dot(n, np.asarray(orient_toward, dtype=np.float64) - pt) < 0:
            n = -n
    return n


# ---------------------------------------------------------------------------
# Projection-based visibility
# ---------------------------------------------------------------------------
def find_visible_cameras(pt, max_results=20, center_threshold=0.6, max_dist_to_cam=15.0,
                         view_direction=None, max_view_angle=None,
                         occlusion=False, occ_radius=OCC_RADIUS,
                         occ_solid_density=OCC_SOLID_DENSITY,
                         sort_by="distance", surface_normal=None, max_incidence_deg=None,
                         max_cameras=300):
    pt    = np.asarray(pt, dtype=np.float64)
    dists = np.linalg.norm(_world_pos - pt, axis=1)
    mask  = dists <= max_dist_to_cam
    if not mask.any():
        return []
    # Speed cap: only ever consider the nearest `max_cameras` cameras. These scenes
    # have thousands of densely-packed frames, and the occlusion ray-test is the
    # expensive step, so bounding the candidate count keeps /query fast. Results are
    # distance-ranked and only a handful are returned, so the far ones we drop here
    # would never have surfaced anyway.
    if max_cameras and int(np.count_nonzero(mask)) > max_cameras:
        cand = np.where(mask)[0]
        keep = cand[np.argpartition(dists[cand], max_cameras)[:max_cameras]]
        mask = np.zeros_like(mask)
        mask[keep] = True
    mdists = dists[mask]   # distance from each candidate camera to the point
    pt_cams  = (_Rs[mask] @ pt) + _ts[mask]
    X, Y, Z  = pt_cams[:, 0], pt_cams[:, 1], pt_cams[:, 2]
    cp = _cam_params[mask]
    W, H = cp[:, 4], cp[:, 5]
    eq = _cam_equirect[mask] if _cam_equirect is not None else np.zeros(len(X), bool)

    u = np.zeros(len(X)); v = np.zeros(len(X)); in_front = np.zeros(len(X), bool)
    ph = ~eq
    # Pinhole cameras: perspective projection, point must be in front (Z > 0).
    if ph.any():
        okz    = Z > 0.01
        safe_z = np.where(okz, Z, 1.0)
        u = np.where(ph, cp[:, 0] * (X / safe_z) + cp[:, 2], u)
        v = np.where(ph, cp[:, 1] * (Y / safe_z) + cp[:, 3], v)
        in_front = np.where(ph, okz, in_front)
    # Equirectangular (360) cameras: whole sphere is captured, so any point that
    # isn't at the camera centre is imaged. u = longitude, v = latitude.
    if eq.any():
        lon = np.arctan2(X, Z)
        lat = np.arctan2(Y, np.hypot(X, Z))
        u = np.where(eq, (lon / (2 * np.pi) + 0.5) * W, u)
        v = np.where(eq, (0.5 + lat / np.pi) * H, v)
        r = np.sqrt(X * X + Y * Y + Z * Z)
        in_front = np.where(eq, r > 1e-6, in_front)

    in_frame = in_front & (u >= 0) & (u < W) & (v >= 0) & (v < H)
    centr    = np.maximum(np.abs((u/W - 0.5)*2), np.abs((v/H - 0.5)*2))
    # Centrality gating applies only to pinhole cameras. For a 360 camera the point
    # can sit anywhere on the sphere and still be genuinely photographed, so
    # "centered in frame" is not a visibility criterion — occlusion + distance are.
    in_frame &= (eq | (centr <= center_threshold))

    # View-angle filter: keep only cameras that look at the point from roughly the
    # same direction as the viewer. Each camera's direction to the point is
    # (pt - camera_world_pos); compare it to the requested view_direction.
    view_angle = None
    if view_direction is not None and max_view_angle is not None:
        vd = np.asarray(view_direction, dtype=np.float64)
        vd_norm = np.linalg.norm(vd)
        if vd_norm > 1e-9:
            vd = vd / vd_norm
            cam_to_pt = pt - _world_pos[mask]
            c2p_norm  = np.linalg.norm(cam_to_pt, axis=1)
            c2p_norm  = np.where(c2p_norm > 1e-9, c2p_norm, 1.0)
            cam_to_pt = cam_to_pt / c2p_norm[:, None]
            cos_ang   = np.clip(cam_to_pt @ vd, -1.0, 1.0)
            view_angle = np.degrees(np.arccos(cos_ang))
            in_frame &= (view_angle <= float(max_view_angle))

    # Surface-facing (incidence) filter: keep only cameras that look at the surface
    # from the front within max_incidence_deg of its local normal. Removes grazing,
    # across-the-room and edge-on views of the clicked surface. surface_normal is a
    # unit vector already oriented toward the camera side of the surface.
    if surface_normal is not None and max_incidence_deg is not None:
        n = np.asarray(surface_normal, dtype=np.float64)
        nn = np.linalg.norm(n)
        if nn > 1e-9:
            n = n / nn
            cam_dir = _world_pos[mask] - pt          # point -> camera
            cd_norm = np.linalg.norm(cam_dir, axis=1)
            cd_norm = np.where(cd_norm > 1e-9, cd_norm, 1.0)
            cam_dir = cam_dir / cd_norm[:, None]
            incidence = np.degrees(np.arccos(np.clip(cam_dir @ n, -1.0, 1.0)))
            in_frame &= (incidence <= float(max_incidence_deg))

    # Occlusion filter: drop cameras whose line of sight to the point is blocked
    # by scene geometry (e.g. a wall between the camera and the surface). Applied
    # to the full in-frame candidate set before ranking/truncation so behind-wall
    # views are removed from the whole pool, not just the top few.
    if occlusion and in_frame.any():
        cand_local = np.where(in_frame)[0]
        cam_world  = _world_pos[mask][cand_local]
        occ = _occluded_mask(cam_world, pt,
                             occ_radius=occ_radius, solid_density=occ_solid_density)
        _occ_stats.clear()
        _occ_stats.update(active=True, candidates=int(len(cand_local)),
                          removed=int(occ.sum()), all_blocked=bool(occ.all()),
                          scipy=bool(_HAS_SCIPY and kdtree is not None))
        # Never let occlusion empty the pool: if every candidate is flagged, keep
        # them all rather than returning nothing (the caller also has a fallback).
        if occ.all():
            log.info("occlusion: all %d candidates blocked; keeping unfiltered", len(cand_local))
            _occ_stats["removed"] = 0
        else:
            blocked = cand_local[occ]
            in_frame[blocked] = False
            log.info("occlusion: %d/%d candidates removed as behind-wall (scipy=%s)",
                     int(occ.sum()), len(cand_local), _occ_stats["scipy"])
    elif occlusion:
        _occ_stats.clear(); _occ_stats.update(active=True, candidates=0, removed=0)

    mask_idx = np.where(mask)[0]
    results  = []
    for gi in np.where(in_frame)[0]:
        img_id = _img_ids[mask_idx[gi]]
        ang    = float(view_angle[gi]) if view_angle is not None else 0.0
        results.append((img_id, float(u[gi]), float(v[gi]), float(centr[gi]),
                        ang, float(mdists[gi])))
    # Ranking. "distance" (default) surfaces the closest cameras first, which give
    # the most detail on the clicked surface; a faraway camera that happens to hold
    # the point dead-centre no longer outranks a good close-up. "centrality" keeps
    # the original most-centered-first behaviour.
    if sort_by == "centrality":
        results.sort(key=lambda r: (r[3], r[4]))
    else:
        # Bucket distance to ~0.5 m so near-equal distances fall back to centeredness.
        results.sort(key=lambda r: (round(r[5] / 0.5), r[3]))
    return results[:max_results]


def _spread_by_distance(pool, near_count, step):
    """Keep the closest `near_count` photos, then pick the rest stepping outward so
    they are progressively farther (>= step metres apart) instead of a burst of
    near-duplicate close-ups. `pool` is distance-sorted; item[5] is camera distance.
    Skipped (too-close) photos are appended after the spread picks so pagination
    and the never-empty guarantee still hold."""
    if step <= 0 or len(pool) <= near_count:
        return pool
    near     = pool[:near_count]
    last_d   = near[-1][5] if near else 0.0
    tail, leftover = [], []
    for r in pool[near_count:]:
        if r[5] >= last_d + step:
            tail.append(r); last_d = r[5]
        else:
            leftover.append(r)
    return near + tail + leftover

# ---------------------------------------------------------------------------
# EXR loading
# ---------------------------------------------------------------------------
def _load_exr_as_bgr(path):
    img = cv2.imread(path, cv2.IMREAD_ANYCOLOR | cv2.IMREAD_ANYDEPTH)
    if img is None:
        return None
    if img.dtype != np.uint8:
        img = np.clip(img / (img + 1.0) * 255, 0, 255).astype(np.uint8)
    return img

def _encode_jpeg_b64(bgr, crosshair_uv=None, scale=0.5):
    h, w  = bgr.shape[:2]
    small = cv2.resize(bgr, (int(w*scale), int(h*scale)))
    if crosshair_uv:
        u, v = int(crosshair_uv[0]*scale), int(crosshair_uv[1]*scale)
        arm  = max(8, small.shape[1] // 40)
        cv2.line(small,   (u-arm,v), (u+arm,v), (0,255,0), 2)
        cv2.line(small,   (u,v-arm), (u,v+arm), (0,255,0), 2)
        cv2.circle(small, (u,v), arm//2, (0,255,0), 1)
    _, buf = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, 82])
    return base64.b64encode(buf).decode()

# ---------------------------------------------------------------------------
# FastAPI
# ---------------------------------------------------------------------------
app = FastAPI(title="Photo API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

@app.on_event("startup")
async def _startup():
    _build_image_file_map()
    _load_cameras()
    _load_images()
    _load_points()
    _build_camera_arrays()
    _load_calibration()

# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
# Default images per /query when the client omits max_results.
DEFAULT_MAX_RESULTS = 6
MAX_RESULTS_CAP = 200


class QueryReq(BaseModel):
    x: float; y: float; z: float
    max_results:      int   = DEFAULT_MAX_RESULTS
    offset:           int   = 0
    center_threshold: float = 0.6
    include_images:   bool  = True
    add_marker:       bool  = False
    max_dist_to_cam:  float = 15.0
    # Optional view-angle filter. view_direction is a unit vector in COLMAP space
    # pointing from the viewer's camera toward the clicked point (i.e. the way the
    # user is looking at that surface). When provided, only photos whose own
    # camera-to-point direction is within max_view_angle degrees are returned, so
    # results come from a similar angle instead of every camera that sees it.
    view_direction:   Optional[List[float]] = None
    camera_position:  Optional[List[float]] = None
    max_view_angle:   Optional[float]       = None
    # Occlusion filter: drop photos whose line of sight to the clicked surface is
    # blocked by scene geometry (e.g. cameras behind a wall). On by default.
    # occ_radius / occ_solid_density tune sensitivity: larger solid_density = more
    # geometry required to call a sight-line blocked (fewer photos removed).
    occlusion_filter:   bool  = True
    occ_radius:         float = OCC_RADIUS
    occ_solid_density:  int   = OCC_SOLID_DENSITY
    # Ranking of the returned photos: "distance" (default) puts the closest cameras
    # first so you get the best close-up of the clicked surface; "centrality" keeps
    # the legacy most-centered-first order.
    sort_by:            str   = "distance"
    # Distance spread (only when sort_by="distance"). Return the closest `near_count`
    # photos, then step the remaining slots outward so they are progressively farther
    # apart (at least `spread_step` metres) instead of many near-identical close-ups.
    # Set spread_step=0 to disable and get strictly the closest photos.
    near_count:         int   = 4
    spread_step:        float = 0.2
    # Optional surface-facing filter. When max_incidence_deg is set, the local
    # surface normal at the clicked point is estimated from the cloud and only
    # cameras viewing the surface from the front within that many degrees are kept
    # (e.g. 60 removes grazing / across-the-room / edge-on views). Leave null to
    # disable. Lower = stricter.
    max_incidence_deg:  Optional[float] = None
    # Speed cap: only the nearest this-many cameras are ever considered per query.
    # Bounds the expensive occlusion test in scenes with thousands of frames.
    max_cameras:        int   = 300

class CalAddReq(BaseModel):
    label:      str
    splat_xyz:  List[float]
    colmap_xyz: List[float]

class CalSetReq(BaseModel):
    R:     List[List[float]]
    t:     List[float]
    scale: float = 1.0
    note:  str   = "manual"

# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
@app.get("/health")
def health():
    return {"status": "ok",
            "build": OCC_BUILD,
            "occlusion_available": bool(_HAS_SCIPY and kdtree is not None),
            "occlusion_default_on": True,
            "points": len(points) if points is not None else 0,
            "images": len(images),
            "cameras": len(cameras),
            "image_files_found": len(_image_file_map),
            "calibration_pairs": len(_cal_pairs),
            "calibration_active": _cal_transform is not None}

@app.post("/query")
def query(req: QueryReq):
    cx, cy, cz = _apply_transform(req.x, req.y, req.z)
    query_pt = np.array([cx, cy, cz], dtype=np.float64)

    # If a calibration transform is active, the incoming view_direction is in the
    # client's raw frame; rotate it into COLMAP space so the angle filter matches.
    view_dir = req.view_direction
    if view_dir is not None and _cal_transform is not None:
        Rc = np.array(_cal_transform["R"])
        vv = Rc @ np.asarray(view_dir, dtype=float)
        nv = np.linalg.norm(vv)
        view_dir = (vv / nv).tolist() if nv > 1e-9 else view_dir

    dist, idx = _nearest_point(query_pt.astype(np.float32))
    snapped = points[idx].tolist()
    max_results = max(1, min(int(req.max_results), MAX_RESULTS_CAP))
    # Fetch one extra so we can tell the client whether more cameras are available.
    need = req.offset + max_results + 1
    # When spreading by distance, pull a wider pool so there are farther cameras to
    # step outward into (image encoding still only happens on the final page).
    spreading = req.sort_by == "distance" and req.spread_step and req.spread_step > 0
    fetch = max(need, 80) if spreading else need

    # Estimate the local surface normal only if the surface-facing filter is on.
    surf_normal = None
    if req.max_incidence_deg is not None and _world_pos is not None:
        near = _world_pos[np.linalg.norm(_world_pos - query_pt, axis=1) <= req.max_dist_to_cam]
        hint = near.mean(axis=0) if len(near) else _world_pos.mean(axis=0)
        surf_normal = _estimate_normal(query_pt, orient_toward=hint)

    # Project the clicked point, not the snapped floater (viewer vs PlayCanvas mismatch).
    visible = find_visible_cameras(
        query_pt,
        max_results=fetch,
        center_threshold=req.center_threshold,
        max_dist_to_cam=req.max_dist_to_cam,
        view_direction=view_dir,
        max_view_angle=req.max_view_angle,
        occlusion=req.occlusion_filter,
        occ_radius=req.occ_radius,
        occ_solid_density=req.occ_solid_density,
        sort_by=req.sort_by,
        surface_normal=surf_normal,
        max_incidence_deg=req.max_incidence_deg,
        max_cameras=req.max_cameras,
    )
    # If the center filter is too tight, widen it so we still fill the pool. The
    # view-angle filter is kept — if the user asked for a specific angle we honour
    # it even when that means fewer photos.
    if len(visible) < need:
        visible = find_visible_cameras(
            query_pt,
            max_results=fetch,
            center_threshold=1.0,
            max_dist_to_cam=max(req.max_dist_to_cam, 30.0),
            view_direction=req.view_direction,
            max_view_angle=req.max_view_angle,
            occlusion=req.occlusion_filter,
            occ_radius=req.occ_radius,
            occ_solid_density=req.occ_solid_density,
            sort_by=req.sort_by,
            surface_normal=surf_normal,
            max_incidence_deg=req.max_incidence_deg,
            max_cameras=req.max_cameras,
        )
    # Last resort: if the angle filter left nothing at all, drop it so the user
    # still sees the point rather than an empty panel.
    if len(visible) == 0 and req.view_direction is not None:
        visible = find_visible_cameras(
            query_pt,
            max_results=fetch,
            center_threshold=1.0,
            max_dist_to_cam=max(req.max_dist_to_cam, 30.0),
            occlusion=req.occlusion_filter,
            occ_radius=req.occ_radius,
            occ_solid_density=req.occ_solid_density,
            sort_by=req.sort_by,
            max_cameras=req.max_cameras,
        )
    # Final safety net: if the occlusion or surface-facing filter left nothing, drop
    # them so the panel is never empty (better a possibly-occluded photo than none).
    if len(visible) == 0 and (req.occlusion_filter or req.max_incidence_deg is not None):
        visible = find_visible_cameras(
            query_pt,
            max_results=fetch,
            center_threshold=1.0,
            max_dist_to_cam=max(req.max_dist_to_cam, 30.0),
            occlusion=False,
            sort_by=req.sort_by,
            max_cameras=req.max_cameras,
        )
    pool = visible
    # Closest few as-is, then step the rest outward in distance for variety.
    if spreading:
        pool = _spread_by_distance(pool, max(0, req.near_count), req.spread_step)
    has_more = len(pool) > req.offset + max_results
    visible = pool[req.offset : req.offset + max_results]
    results = []
    for img_id, u, v, score, view_ang, cam_dist in visible:
        img = images[img_id]
        cam = cameras.get(img["cam_id"], {})
        is_360 = bool(cam.get("equirect"))
        W = float(cam.get("w", 0)) or 1.0
        H = float(cam.get("h", 0)) or 1.0
        # For a 360 image, u,v are longitude/latitude pixels. Convert to the yaw/pitch
        # a panorama viewer needs so it opens looking straight at the clicked point.
        pano_yaw   = (u / W - 0.5) * 360.0
        pano_pitch = -(v / H - 0.5) * 180.0
        entry = {
            "image_id": img_id,
            "image_name": img["name"],
            "colmap_name": img["name"],
            "exr_path": img["exr_path"] or "",
            "centrality": round(score, 4),
            "score": round(score, 4),
            "view_angle": round(view_ang, 1),
            "camera_distance": round(cam_dist, 2),
            "projected_uv": [round(u, 1), round(v, 1)],
            "u": round(u, 1),
            "v": round(v, 1),
            "is_360": is_360,
            "pano_yaw": round(pano_yaw, 2),
            "pano_pitch": round(pano_pitch, 2),
            "image_url": f"/raw_image/{img_id}",
            "filename": (
                os.path.basename(img["exr_path"])
                if img["exr_path"]
                else img["name"].replace("\\", "/").split("/")[-1]
            ),
            "rank": len(results),
        }
        if req.include_images and img["exr_path"]:
            bgr = _load_exr_as_bgr(img["exr_path"])
            if bgr is not None:
                marker_uv = (u, v) if req.add_marker else None
                b64 = _encode_jpeg_b64(bgr, crosshair_uv=marker_uv)
                entry["image_b64"] = b64
                entry["base64"] = b64
                entry["data_url"] = "data:image/jpeg;base64," + b64
                entry["content_type"] = "image/jpeg"
            else:
                entry["error"] = "failed to load EXR"
        elif req.include_images:
            entry["error"] = "image file not found"
        results.append(entry)
    return {
        "queried": {"x": req.x, "y": req.y, "z": req.z},
        "colmap_xyz": [cx, cy, cz],
        "snapped_xyz": snapped,
        "nearest_dist": round(float(dist), 4),
        "visible_count": len(visible),
        "returned": len(results),
        "results": results,
        "images": results,
        "point_id": int(idx),
        "snap_distance": round(float(dist), 4),
        "has_more": has_more,
        "occlusion": dict(_occ_stats),
        "build": OCC_BUILD,
    }

@app.get("/image/{img_id}")
def get_image(img_id: int):
    img = images.get(img_id)
    if not img or not img["exr_path"]:
        return {"error": "not found"}
    bgr = _load_exr_as_bgr(img["exr_path"])
    if bgr is None:
        return {"error": "load failed"}
    return {"image_b64": _encode_jpeg_b64(bgr)}

@app.get("/raw_image/{img_id}")
def raw_image(img_id: int, max_w: int = 0):
    """Serve the source image. Used by the client viewer.

    max_w caps the width in pixels: the client requests small widths for the result
    thumbnails (so each downloads quickly and cards fill in progressively) and a
    larger width for the full-screen view. max_w=0 (or >= the image width) serves the
    original untouched."""
    from fastapi.responses import Response
    img = images.get(img_id)
    if not img or not img["exr_path"]:
        return {"error": "not found"}
    path = img["exr_path"]
    ext = os.path.splitext(path)[1].lower()

    if max_w and max_w > 0:
        bgr = _load_exr_as_bgr(path)
        if bgr is None:
            return {"error": "load failed"}
        h, w = bgr.shape[:2]
        if w > max_w:
            nh = max(1, int(round(h * max_w / float(w))))
            bgr = cv2.resize(bgr, (int(max_w), nh), interpolation=cv2.INTER_AREA)
        ok, buf = cv2.imencode(".jpg", bgr, [cv2.IMWRITE_JPEG_QUALITY, 88])
        if not ok:
            return {"error": "encode failed"}
        return Response(content=buf.tobytes(), media_type="image/jpeg")

    # No cap: serve the original as-is (browser-friendly) or transcode EXR.
    if ext in (".jpg", ".jpeg", ".png", ".webp"):
        media = "image/png" if ext == ".png" else ("image/webp" if ext == ".webp" else "image/jpeg")
        return FileResponse(path, media_type=media)
    bgr = _load_exr_as_bgr(path)
    if bgr is None:
        return {"error": "load failed"}
    b64 = _encode_jpeg_b64(bgr, scale=1.0)
    return Response(content=base64.b64decode(b64), media_type="image/jpeg")

@app.get("/points_lite")
def points_lite(step: int = 5):
    if points is None:
        return {"error": "not loaded"}
    idx  = np.arange(0, len(points), step)
    pts  = points[idx].tolist()
    cols = _point_colors[idx].tolist() if _point_colors is not None else None
    return {"points": pts, "colors": cols, "count": len(pts), "step": step}

@app.get("/")
def root():
    return RedirectResponse(url="/viewer")

@app.get("/viewer", response_class=HTMLResponse)
def viewer():
    html_path = os.path.join(BASE_DIR, "viewer.html")
    if os.path.exists(html_path):
        return HTMLResponse(content=open(html_path, encoding="utf-8").read())
    return HTMLResponse(content="<h2>viewer.html not found next to photo_api.py</h2>")

# -- Calibration -------------------------------------------------------------
@app.get("/calibrate/status")
def cal_status():
    return {"pairs": _cal_pairs, "pair_count": len(_cal_pairs), "transform": _cal_transform}

@app.post("/calibrate/add")
def cal_add(req: CalAddReq):
    global _cal_pairs
    _cal_pairs.append({"label": req.label, "splat": req.splat_xyz, "colmap": req.colmap_xyz})
    _save_calibration()
    return {"pair_count": len(_cal_pairs), "pairs": _cal_pairs}

@app.post("/calibrate/compute")
def cal_compute():
    global _cal_transform
    if len(_cal_pairs) < 3:
        return {"error": f"Need at least 3 pairs, have {len(_cal_pairs)}"}
    _cal_transform = _compute_transform(_cal_pairs)
    _save_calibration()
    return _cal_transform

@app.post("/calibrate/set")
def cal_set(req: CalSetReq):
    global _cal_transform
    _cal_transform = {"R": req.R, "t": req.t, "scale": req.scale,
                      "method": req.note, "residuals": [], "mean_error": 0}
    _save_calibration()
    return _cal_transform

@app.delete("/calibrate/clear")
def cal_clear():
    global _cal_pairs, _cal_transform
    _cal_pairs, _cal_transform = [], None
    _save_calibration()
    return {"cleared": True}

# ---------------------------------------------------------------------------
if __name__ == "__main__":
    port = int(os.environ.get("PHOTO_API_PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port, reload=False)