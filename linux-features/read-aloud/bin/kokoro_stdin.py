#!/usr/bin/env python3
"""Read stdin aloud with Kokoro ONNX and aplay."""

from __future__ import annotations

import os
import queue
import re
import subprocess
import sys
import threading


def env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, str(default)))
    except ValueError:
        return default


def env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except ValueError:
        return default


def split_fragment_at_limit(text: str, max_chars: int) -> tuple[str, str]:
    if len(text) <= max_chars:
        return text, ""

    cut = text.rfind(" ", 0, max_chars + 1)
    if cut < max_chars // 2:
        cut = max_chars
    return text[:cut].strip(), text[cut:].strip()


def split_for_streaming(text: str) -> list[str]:
    first_chars = max(40, env_int("CODEX_LINUX_READ_ALOUD_KOKORO_FIRST_CHARS", 90))
    chunk_chars = max(80, env_int("CODEX_LINUX_READ_ALOUD_KOKORO_CHUNK_CHARS", 180))
    cleaned = text.strip()
    sentences = re.split(r"(?<=[.!?])\s+", cleaned)
    chunks: list[str] = []
    current = ""
    for sentence in sentences:
        fragment = sentence.strip()
        while fragment:
            limit = first_chars if not chunks else chunk_chars
            if current:
                candidate = f"{current} {fragment}".strip()
                if len(candidate) <= limit:
                    current = candidate
                    break
                chunks.append(current.strip())
                current = ""
                continue

            current, fragment = split_fragment_at_limit(fragment, limit)
            if fragment:
                chunks.append(current.strip())
                current = ""
    if current:
        chunks.append(current.strip())
    return chunks or ([cleaned] if cleaned else [])


def enqueue(output: queue.Queue[object], item: object, stop_event: threading.Event) -> None:
    while not stop_event.is_set():
        try:
            output.put(item, timeout=0.1)
            return
        except queue.Full:
            continue


def synthesize_chunks(
    output: queue.Queue[object],
    stop_event: threading.Event,
    chunks: list[str],
    model: str,
    voices: str,
    voice: str,
    speed: float,
    lang: str,
) -> None:
    try:
        from kokoro_onnx import Kokoro  # type: ignore
        import numpy as np

        kokoro = Kokoro(model, voices)
        for chunk in chunks:
            if stop_event.is_set():
                break
            samples, _ = kokoro.create(chunk, voice=voice, speed=speed, lang=lang)
            pcm = np.clip(samples, -1.0, 1.0)
            enqueue(output, (pcm * 32767.0).astype("<i2").tobytes(), stop_event)
    except Exception as exc:
        enqueue(output, exc, stop_event)
    finally:
        enqueue(output, None, stop_event)


def main() -> int:
    threads = str(env_int("CODEX_LINUX_READ_ALOUD_KOKORO_THREADS", 4))
    os.environ.setdefault("OMP_NUM_THREADS", threads)
    os.environ.setdefault("ORT_NUM_THREADS", threads)

    text = sys.stdin.read().strip()
    if not text:
        return 0

    model = os.environ["CODEX_LINUX_READ_ALOUD_KOKORO_MODEL"]
    voices = os.environ["CODEX_LINUX_READ_ALOUD_KOKORO_VOICES"]
    voice = os.environ.get("CODEX_LINUX_READ_ALOUD_KOKORO_VOICE", "bm_george")
    speed = min(1.4, max(0.7, env_float("CODEX_LINUX_READ_ALOUD_KOKORO_SPEED", 1.05)))
    lang = os.environ.get("CODEX_LINUX_READ_ALOUD_KOKORO_LANG", "en-us")

    sample_rate = 24000
    chunks = split_for_streaming(text)
    # Deeper queue so synthesis can run ahead of playback. Under CPU
    # contention a chunk can take several seconds; keeping later chunks
    # rendered and waiting reduces playback starvation.
    audio_queue: queue.Queue[object] = queue.Queue(maxsize=32)
    stop_event = threading.Event()
    worker = threading.Thread(
        target=synthesize_chunks,
        args=(audio_queue, stop_event, chunks, model, voices, voice, speed, lang),
        daemon=True,
    )
    worker.start()

    # Do not open aplay until the first PCM chunk is ready.
    # The previous version spawned aplay up front and then synthesized
    # chunk 0 (seconds of work on a busy CPU). aplay sat on an empty ALSA
    # buffer and underran immediately, heard as the last fragment looping,
    # followed by a gap when real audio finally arrived. Pulling the first
    # item first means aplay opens with audio already in hand.
    first = audio_queue.get()
    if first is None:
        return 0
    if isinstance(first, Exception):
        return 1
    if not isinstance(first, (bytes, bytearray, memoryview)):
        return 1

    # --buffer-time/--period-time give ALSA a real cushion (0.5s buffer,
    # 0.1s period) to ride out scheduling jitter on a loaded machine. The
    # deep queue is the primary defense; this is cheap insurance.
    player = subprocess.Popen(
        [
            "aplay", "-q", "-r", str(sample_rate), "-c", "1",
            "-f", "S16_LE", "-t", "raw",
            "--buffer-time=500000", "--period-time=100000",
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    try:
        assert player.stdin is not None
        item: object = first
        while True:
            if player.poll() is not None:
                break
            if item is None:
                break
            if isinstance(item, Exception):
                return 1
            if not isinstance(item, (bytes, bytearray, memoryview)):
                return 1
            player.stdin.write(item)
            player.stdin.flush()
            item = audio_queue.get()
        player.stdin.close()
        player.wait(timeout=5)
    except BrokenPipeError:
        return 0
    except subprocess.TimeoutExpired:
        return 0
    finally:
        stop_event.set()
        if player.poll() is None:
            player.terminate()
        worker.join(timeout=0.2)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
