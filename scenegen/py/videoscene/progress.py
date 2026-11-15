import json
import sys


def emit(stage, progress=None, message="", **extra):
    msg = {"stage": stage}
    if progress is not None:
        msg["progress"] = round(float(max(0.0, min(1.0, progress))), 4)
    if message:
        msg["message"] = message
    msg.update(extra)
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()
