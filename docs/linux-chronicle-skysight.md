# Linux Chronicle / Skysight

Chronicle/Skysight is opt-in screen and event memory on Linux. It can run as a
standalone feature with a restricted Skysight-only MCP server. Record & Replay
requires and uses the same backend for demo-to-skill capture. It is not a
microphone transcription system.

## Relationship To Record & Replay

- Record & Replay owns the user-facing demo-to-skill flow.
- Chronicle/Skysight can be enabled alone for recent activity memory.
- Record & Replay configuration must explicitly enable both
  `chronicle-skysight` and `record-and-replay`.
- Chronicle/Skysight keeps the recent activity memory that helps draft the
  resulting skill.
- `speech_context` remains the transcript channel when spoken text is
  available; it is separate from Chronicle-compatible resources.

## Runtime Locations

- Runtime state: `$XDG_RUNTIME_DIR/skysight`
- Chronicle-compatible resources:
  `${CODEX_HOME:-$HOME/.codex}/memories/extensions/chronicle/resources`
- Segment evidence:
  `$XDG_RUNTIME_DIR/skysight/segments/<timestamp>-linux-activity/`

Each segment writes:

- `events.jsonl` with diagnostics, provider readiness, artifact references,
  capture errors, and suppressed-evidence records.
- `metadata.json` with event, artifact, exclusion, and suppression counts.
- `artifacts/` with bounded local evidence such as diagnostics, screenshot
  files, window/app metadata, and AT-SPI/accessibility snapshots when available.

Skysight writes rolling `*-10min-*.md` resources for recent segment windows and
cadence-limited `*-6h-*.md` rollups. Exclusion rules suppress matching
window/app/accessibility evidence and record suppression counts instead of
copying excluded content into resources.

## Local OCR

Linux Chronicle OCR is local-only and optional. In `auto` backend mode,
Skysight prefers RapidOCR through Python + ONNXRuntime when those packages are
available, then falls back to the Tesseract CLI. Both backends run after the
screenshot privacy gate passes and append recognized text plus bounding boxes
to `*.ocr.jsonl`.

When OCR is disabled or unavailable, Skysight still writes the Chronicle OCR
history contract with `runs_ocr=false`, empty `normalized_text`, and an
explicit `ocr_status` such as `disabled`, `backend_unavailable`, or
`required_backend_unavailable`. This is a truthful local capability status, not
Apple Vision parity.

OCR never runs before screenshot/domain/window exclusions. If screenshot
evidence is suppressed, no OCR attempt is made. If recognized OCR text matches
an exclusion value before persistence, the OCR row is kept but text and
observations are stripped and `ocr_status` becomes
`suppressed_by_exclusion_text`. Rolling markdown resources summarize OCR
status, paths, and byte counts; they do not dump raw OCR text by default.

RapidOCR/ONNXRuntime is the preferred advanced backend for screen OCR because
it is local, fast on CPU, and generally stronger than classic OCR on rendered
UI screenshots. Tesseract remains the fallback baseline because it is broadly
packaged, offline, and emits word boxes through TSV without Python packages.

### OCR Backend Direction

`auto` is the default Linux Chronicle OCR backend selection. It chooses
RapidOCR/ONNXRuntime first when available and falls back to Tesseract. That
keeps continuous screen memory privacy-preserving and useful without making
model packages mandatory for every Linux install.

The backend boundary should stay pluggable. Current and future OCR stacks:

- RapidOCR/ONNXRuntime is the preferred optional advanced provider. It
  packages PaddleOCR-style models for fast offline deployment, supports local
  CPU inference, and keeps the default feature from depending on the larger
  PaddlePaddle/PyTorch runtime stack.
- PaddleOCR remains the upstream model family to watch for accuracy and model
  refreshes. Its PP-OCR deployment paths cover broad multilingual scene OCR and
  acceleration through OpenVINO, ONNX Runtime, TensorRT, and native inference
  paths.
- Surya is attractive for document-heavy workflows that need layout, reading
  order, tables, and OCR together, but its current model stack and inference
  server requirements are heavier than a per-minute desktop-memory default.
- EasyOCR is easy to try and multilingual, but it is older and PyTorch-heavy
  compared with current PaddleOCR and Surya options.
- docTR is a clean deep-learning document OCR library, but it is less focused
  on lightweight desktop screenshot memory than the options above.

The practical target is therefore: keep `auto` as the default, prefer
`rapidocr-python` when available, preserve `tesseract-cli` as fallback, and
never make model downloads or GPU frameworks mandatory for the base Chronicle
feature.

Runtime controls:

```bash
CODEX_SKYSIGHT_OCR=auto|enabled|required|disabled
CODEX_CHRONICLE_OCR=auto|enabled|required|disabled
CODEX_SKYSIGHT_OCR_BACKEND=auto|rapidocr|tesseract
CODEX_CHRONICLE_OCR_BACKEND=auto|rapidocr|tesseract
CODEX_SKYSIGHT_RAPIDOCR_PYTHON=/path/to/python3
CODEX_CHRONICLE_RAPIDOCR_PYTHON=/path/to/python3
CODEX_SKYSIGHT_RAPIDOCR_LANG=ch
CODEX_CHRONICLE_RAPIDOCR_LANG=ch
CODEX_SKYSIGHT_TESSERACT_PATH=/path/to/tesseract
CODEX_CHRONICLE_TESSERACT_PATH=/path/to/tesseract
CODEX_SKYSIGHT_OCR_LANG=eng
CODEX_SKYSIGHT_OCR_PSM=11
CODEX_SKYSIGHT_OCR_TIMEOUT_MS=10000
```

For RapidOCR, the selected Python environment must be able to import
`rapidocr`, `onnxruntime`, and OpenCV. On minimal Debian/Ubuntu containers this
may also require the system package that provides `libGL.so.1`.

## Verification After Rebuild

1. Run `node --test linux-features/chronicle-skysight/test.js linux-features/record-and-replay/test.js`.
2. Rebuild and reinstall the feature bundle.
3. Confirm the bridge exposes `linux-record-replay-skysight-pause` and
   `linux-record-replay-skysight-resume`.
4. Confirm `skysight status` reports the active resource path.
5. Exercise `skysight pause`, `skysight resume`, and `skysight stop` through
   the helper or bridge.
6. Capture `skysight snapshot` and confirm the segment has `events.jsonl`,
   `metadata.json`, `artifacts/diagnostics.json`, a `*-10min-*.md` resource,
   and either a newly-created or previously-current `*-6h-*.md` rollup.
