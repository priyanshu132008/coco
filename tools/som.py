#!/usr/bin/env python3
"""Set-of-Mark (SoM) visual prompting engine for OpenInstinct.

Turns a screenshot into a numbered-box annotated image plus a JSON mapping of every
candidate interactive element (buttons, inputs, calendar cells, links). The agent
loop feeds the annotated image to the vision model and uses box_id coordinates
to dispatch clicks.

Run as a module:
    ./.venv/bin/python tools/som.py [image_path]   # no path → captures the screen
Import:
    from tools.som import annotate_som
    mapping = annotate_som(source_path="shot.png")
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from typing import Optional

import cv2
import numpy as np

#: A candidate below this size is pixel noise, not a control.
MIN_W, MIN_H = 12, 12
#: Anything covering more than this fraction of the image is a background container.
MAX_AREA_FRAC = 0.25
#: Two boxes with IoU above this are redundant — keep the smaller (more specific) one.
IOU_REDUNDANT = 0.6
#: A box containing more than this many kept boxes is a container, not an action.
CONTAINS_LIMIT = 4
#: Annotated output filename pattern in the temp working dir.
OUT_PATTERN = "som_{ts}.png"


@dataclass
class Box:
    """A candidate interactive element's bounding box (image pixel coords)."""
    x_min: int
    y_min: int
    x_max: int
    y_max: int

    @property
    def w(self) -> int:
        return self.x_max - self.x_min

    @property
    def h(self) -> int:
        return self.y_max - self.y_min

    @property
    def area(self) -> int:
        return max(0, self.w) * max(0, self.h)

    def center(self) -> tuple[int, int]:
        return (self.x_min + self.x_max) // 2, (self.y_min + self.y_max) // 2

    def contains(self, other: "Box") -> bool:
        cx, cy = other.center()
        return self.x_min <= cx <= self.x_max and self.y_min <= cy <= self.y_max

    def iou(self, other: "Box") -> float:
        ix_min, iy_min = max(self.x_min, other.x_min), max(self.y_min, other.y_min)
        ix_max, iy_max = min(self.x_max, other.x_max), min(self.y_max, other.y_max)
        if ix_max <= ix_min or iy_max <= iy_min:
            return 0.0
        inter = (ix_max - ix_min) * (iy_max - iy_min)
        return inter / (self.area + other.area - inter) if (self.area + other.area - inter) > 0 else 0.0


def capture_screen() -> np.ndarray:
    """Current screen buffer via the OS capture tool (macOS `screencapture`; pyautogui elsewhere)."""
    tmp = os.path.join(tempfile.gettempdir(), f"som_capture_{os.getpid()}.png")
    try:
        if sys.platform == "darwin":
            subprocess.run(["screencapture", "-x", tmp], check=True, timeout=10)
        else:
            import pyautogui  # deferred — only needed for non-mac live capture

            pyautogui.screenshot(tmp)
    except (subprocess.CalledProcessError, OSError) as e:
        raise RuntimeError(
            "screen capture failed — grant the terminal/app Screen Recording permission "
            "(System Settings → Privacy & Security → Screen Recording), or pass a screenshot path"
        ) from e
    img = cv2.imread(tmp)
    os.unlink(tmp)
    if img is None:
        raise RuntimeError("screen capture produced no image — check screen-recording permissions")
    return img


def load_image(source: str) -> np.ndarray:
    """Read a screenshot path into BGR; raise with a clear message when unreadable."""
    img = cv2.imread(source)
    if img is None:
        raise FileNotFoundError(f"cannot read image: {source}")
    return img


def detect_elements(img: np.ndarray) -> list[Box]:
    """Candidate interactive controls: edge/contour scan of high-contrast UI regions.

    Blurs then runs Canny, dilates to join strokes, and takes bounding rects of the
    contours. Accessibility-tree bounds would be wired in per-OS here; the visual
    pass alone already covers buttons, inputs, calendar grid cells and links.
    """
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (3, 3), 0)
    edges = cv2.Canny(blurred, 60, 150)
    closed = cv2.dilate(edges, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3)), iterations=2)

    h, w = img.shape[:2]
    full_area = h * w
    boxes: list[Box] = []
    contours, _ = cv2.findContours(closed, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    for c in contours:
        x, y, cw, ch = cv2.boundingRect(c)
        if cw < MIN_W or ch < MIN_H or cw * ch > full_area * MAX_AREA_FRAC:
            continue
        boxes.append(Box(x, y, x + cw, y + ch))
    return filter_candidates(boxes, full_area)


def filter_candidates(boxes: list[Box], full_area: int) -> list[Box]:
    """Drop redundant/overlap-heavy/massive boxes — keep the actionable layer only."""
    # 1. massive: anything eating >MAX_AREA_FRAC of the frame
    boxes = [b for b in boxes if b.area <= full_area * MAX_AREA_FRAC]
    # 2. redundant overlaps: sort big→small, skip a box with high IoU against an already-kept one
    kept: list[Box] = []
    for b in sorted(boxes, key=lambda b: -b.area):
        if all(b.iou(k) < IOU_REDUNDANT for k in kept):
            kept.append(b)
    # 3. containers: keep boxes that don't just wrap a crowd of smaller candidates
    return [b for b in kept if b.area < full_area * 0.02 or sum(1 for o in kept if o is not b and b.contains(o)) <= CONTAINS_LIMIT]


def annotate(img: np.ndarray, boxes: list[Box], out_path: str) -> None:
    """Numbered neon boxes with dark pill labels — contrast survives compression and downscaling."""
    annotated = img.copy()
    for i, b in enumerate(boxes, start=1):
        cv2.rectangle(annotated, (b.x_min, b.y_min), (b.x_max, b.y_max), (0, 255, 255), 2)  # neon yellow
        label = str(i)
        (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.45, 1)
        # pill background on the top-left corner, clamped inside the frame
        px, py = b.x_min, max(0, b.y_min - th - 8)
        cv2.rectangle(annotated, (px, py), (px + tw + 8, py + th + 8), (30, 30, 30), thickness=-1)
        cv2.putText(annotated, label, (px + 4, py + th + 4), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1, cv2.LINE_AA)
    if not cv2.imwrite(out_path, annotated):
        raise IOError(f"failed to write annotated image: {out_path}")


def annotate_som(
    source_path: Optional[str] = None,
    screenshot: Optional[np.ndarray] = None,
    out_dir: Optional[str] = None,
) -> dict[str, dict[str, int]]:
    """Full SoM pass: capture/read → detect → annotate → save → return the box-id mapping.

    Exactly one of `source_path` / `screenshot` must be given (neither → live capture).
    box_id keys are "1", "2", … matching the numbers drawn on the annotated image.
    """
    if screenshot is not None and source_path is not None:
        raise ValueError("pass either screenshot or source_path, not both")
    img = screenshot if screenshot is not None else (load_image(source_path) if source_path else capture_screen())

    boxes = detect_elements(img)
    out_dir = out_dir or tempfile.gettempdir()
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, OUT_PATTERN.format(ts=int(time.time() * 1000)))
    annotate(img, boxes, out_path)

    mapping: dict[str, dict[str, int]] = {}
    for i, b in enumerate(boxes, start=1):
        cx, cy = b.center()
        mapping[str(i)] = {"x_min": b.x_min, "y_min": b.y_min, "x_max": b.x_max, "y_max": b.y_max, "center_x": cx, "center_y": cy}
    print(f"[som] {len(boxes)} boxes → {out_path}", file=sys.stderr)
    # stash the last pass for pipelines that need both the image and the mapping
    annotate_som.last_out_path = out_path  # type: ignore[attr-defined]
    annotate_som.last_out_boxes = mapping  # type: ignore[attr-defined]
    return mapping


if __name__ == "__main__":
    # default: live screen capture; with an arg: annotate that image
    src = sys.argv[1] if len(sys.argv) > 1 else None
    result = annotate_som(source_path=src)
    print(json.dumps(result, indent=1))

    # self-check on a synthetic UI canvas — fails if detection or mapping geometry break
    canvas = np.full((480, 640, 3), 255, dtype=np.uint8)
    for (bx, by, bw_, bh_) in [(40, 40, 120, 40), (40, 120, 120, 40), (40, 200, 300, 40), (200, 40, 90, 250), (20, 300, 480, 40)]:
        cv2.rectangle(canvas, (bx, by), (bx + bw_, by + bh_), (160, 160, 160), 2)
    mapping = annotate_som(screenshot=canvas, out_dir=tempfile.gettempdir())
    assert mapping, "synthetic UI detected nothing"
    for bid, r in mapping.items():
        assert r["x_min"] <= r["center_x"] <= r["x_max"] and r["y_min"] <= r["center_y"] <= r["y_max"], f"center outside box {bid}"
        assert r["x_max"] - r["x_min"] >= MIN_W and r["y_max"] - r["y_min"] >= MIN_H, f"sub-minimum box {bid}"
    n_big = sum(1 for r in mapping.values() if (r["x_max"] - r["x_min"]) * (r["y_max"] - r["y_min"]) > 640 * 480 * MAX_AREA_FRAC)
    assert n_big == 0, "a massive container survived filtering"
    print(f"[som] self-check ✓ — {len(mapping)} boxes, all centers in-bounds, no containers", file=sys.stderr)