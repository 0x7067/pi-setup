#!/usr/bin/env python3
"""Loopback MLX-VLM inference worker for the custom-ocr pi extension.

Security model:
- Binds 127.0.0.1 on a randomly allocated port (reported on stdout).
- Requires a bearer token supplied via the CUSTOM_OCR_TOKEN environment
  variable; requests without it are rejected.
- Started with HF_HUB_OFFLINE/TRANSFORMERS_OFFLINE so it can never download
  weights or contact any network service.
- Loads exactly one local model snapshot for its whole lifetime.
- Serves one inference at a time.

stdout protocol (one JSON object per line):
  {"event": "listening", "port": 12345}
  {"event": "loaded"}
  {"event": "error", "message": "..."}
"""

import argparse
import hmac
import json
import os
import queue
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

STATE = {"status": "loading", "error": None}
MODEL = {}
TOKEN = ""

# All inference (load + generate) runs on a single dedicated thread. MLX GPU
# streams are thread-bound: some models (e.g. GLM-OCR) throw "no Stream(gpu, 1)
# in current thread" when generated from a different thread than the one that
# loaded them. Requests are serialized through REQUEST_QUEUE; each carries a
# threading.Event the HTTP handler waits on. This preserves the
# "one inference at a time" contract the old INFERENCE_LOCK provided.
REQUEST_QUEUE: "queue.Queue[tuple[int, dict]]" = queue.Queue()
RESPONSES: dict[int, tuple[str, str | None]] = {}
RESPONSE_COND = threading.Condition()
NEXT_REQUEST_ID = 0


def emit(event: dict) -> None:
    print(json.dumps(event), flush=True)


def inference_loop(model_path: str) -> None:
    """Load the model, then serve generations forever on this same thread."""
    try:
        from mlx_vlm import load
        from mlx_vlm.utils import load_config

        # trust_remote_code=False: mlx-vlm ships native implementations for
        # these model types; the repo's custom (torch-based) code must never
        # run, and this also avoids the interactive trust prompt.
        model, processor = load(model_path, trust_remote_code=False)
        config = load_config(model_path)
        MODEL["model"] = model
        MODEL["processor"] = processor
        MODEL["config"] = config
        STATE["status"] = "ready"
        emit({"event": "loaded"})
    except Exception as error:  # noqa: BLE001 - surfaced to the extension
        STATE["status"] = "failed"
        STATE["error"] = f"{type(error).__name__}: {error}"
        emit({"event": "error", "message": STATE["error"]})
        os._exit(1)

    while True:
        request_id, body = REQUEST_QUEUE.get()
        try:
            text = run_generate(body)
            result = ("ok", text)
        except Exception as error:  # noqa: BLE001 - surfaced as HTTP 500
            result = ("error", f"{type(error).__name__}: {error}")
        with RESPONSE_COND:
            RESPONSES[request_id] = result
            RESPONSE_COND.notify_all()


def validated_image_path(raw_path: str) -> str:
    try:
        path = Path(raw_path).resolve(strict=True)
    except OSError as error:
        raise ValueError(f"image path is invalid: {error}") from error

    temp_root = Path(tempfile.gettempdir()).resolve()
    if (
        not path.is_file()
        or path.parent.parent != temp_root
        or not path.parent.name.startswith("custom-ocr-")
        or not path.name.startswith("page-")
        or path.suffix.lower() != ".png"
    ):
        raise ValueError("image must be a rendered custom-ocr temporary PNG")
    return str(path)


def run_generate(body: dict) -> str:
    from mlx_vlm import generate
    from mlx_vlm.prompt_utils import apply_chat_template

    prompt = apply_chat_template(
        MODEL["processor"], MODEL["config"], body["prompt"], num_images=1
    )
    kwargs = {
        "max_tokens": int(body.get("max_tokens", 4096)),
        "temperature": 0.0,
        "verbose": False,
    }
    penalty = body.get("repetition_penalty")
    if penalty is not None:
        kwargs["repetition_penalty"] = float(penalty)

    result = generate(
        MODEL["model"], MODEL["processor"], prompt, image=[body["image"]], **kwargs
    )
    if isinstance(result, str):
        return result
    if isinstance(result, tuple):
        return str(result[0])
    text = getattr(result, "text", None)
    return text if isinstance(text, str) else str(result)


class Handler(BaseHTTPRequestHandler):
    server_version = "custom-ocr-worker"

    def _reply(self, status: int, payload: dict) -> None:
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _authorized(self) -> bool:
        header = self.headers.get("Authorization", "")
        return hmac.compare_digest(
            header.encode("utf-8", "surrogateescape"),
            f"Bearer {TOKEN}".encode(),
        )

    def do_GET(self):  # noqa: N802 - http.server API
        if self.path != "/health":
            self._reply(404, {"error": "not found"})
            return
        if not self._authorized():
            self._reply(401, {"error": "unauthorized"})
            return
        self._reply(200, {"status": STATE["status"], "error": STATE["error"]})

    def do_POST(self):  # noqa: N802 - http.server API
        if self.path != "/generate":
            self._reply(404, {"error": "not found"})
            return
        if not self._authorized():
            self._reply(401, {"error": "unauthorized"})
            return
        if STATE["status"] != "ready":
            self._reply(503, {"error": f"model is {STATE['status']}"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length))
            if not isinstance(body.get("prompt"), str) or not isinstance(
                body.get("image"), str
            ):
                self._reply(400, {"error": "prompt and image are required"})
                return
            try:
                body["image"] = validated_image_path(body["image"])
            except ValueError as error:
                self._reply(400, {"error": str(error)})
                return
            with RESPONSE_COND:
                # Claim a request id, enqueue the job, then wait for the
                # inference thread to produce a response.
                global NEXT_REQUEST_ID
                request_id = NEXT_REQUEST_ID
                NEXT_REQUEST_ID += 1
                REQUEST_QUEUE.put((request_id, body))
                deadline = time.monotonic() + 600
                while request_id not in RESPONSES:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        self._reply(504, {"error": "generate timed out"})
                        return
                    RESPONSE_COND.wait(remaining)
                status, text = RESPONSES.pop(request_id)
            if status == "ok":
                self._reply(200, {"text": text})
            else:
                self._reply(500, {"error": text})
        except BrokenPipeError:
            pass
        except Exception as error:  # noqa: BLE001 - surfaced to the extension
            self._reply(500, {"error": f"{type(error).__name__}: {error}"})

    def log_message(self, *args):  # silence request logging
        pass


def main() -> None:
    global TOKEN

    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, help="Local model snapshot path")
    args = parser.parse_args()

    TOKEN = os.environ.get("CUSTOM_OCR_TOKEN", "")
    if not TOKEN:
        emit({"event": "error", "message": "CUSTOM_OCR_TOKEN is not set"})
        sys.exit(1)
    if not os.path.isdir(args.model):
        emit({"event": "error", "message": f"model path not found: {args.model}"})
        sys.exit(1)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    emit({"event": "listening", "port": server.server_address[1]})

    # Single inference thread owns load + all generations (MLX stream binding).
    threading.Thread(target=inference_loop, args=(args.model,), daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
