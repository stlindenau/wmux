# wmux command server

FastAPI HTTP front end for the `wmux` CLI, so a Claude Code session inside a
Linux devcontainer (which cannot open a Windows named pipe) can drive wmux
over HTTP instead. See [`../docs/DEVCONTAINER.md`](../docs/DEVCONTAINER.md)
for the full setup and endpoint reference.

## Run it

Normally started via `wmux serve-api` (requires `WMUX_ENABLE_API=1`). To run
directly for development:

```bash
pip install -r requirements.txt
WMUX_PIPE_TOKEN=<token> WMUX_CLI=/path/to/wmux.js \
  uvicorn app:app --host 127.0.0.1 --port 8787
```

## Test

```bash
uv run --with-requirements requirements.txt --with pytest --with httpx pytest test_app.py -v
```
