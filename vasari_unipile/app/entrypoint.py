import sys

import uvicorn

from . import bootstrap, worker


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else "api"
    if mode == "api":
        uvicorn.run("app.main:app", host="0.0.0.0", port=8000)
    elif mode == "worker":
        worker.run()
    elif mode == "bootstrap":
        bootstrap.run()
    else:
        raise SystemExit(f"unknown mode: {mode}")


if __name__ == "__main__":
    main()

