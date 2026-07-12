#!/usr/bin/env python3
"""Codex cognitive-memory hooks for Vasari-BOS.

The markdown files are the durable source of truth. Weaviate is used for
shared recall and compact ingestion.
"""

from __future__ import annotations

import json
import os
import platform
import re
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

PROJECT = os.environ.get("CODEX_MEMORY_PROJECT", "Vasari-BOS")
CLASS_NAME = os.environ.get("CODEX_MEMORY_CLASS", "CodexMemory")
LOCAL_WEAVIATE_URL = "http://100.79.204.28:18082"
HOST_WEAVIATE_URL = "http://127.0.0.1:18082"
DOCKER_WEAVIATE_URL = "http://weaviate:8080"
MAX_CONTEXT_CHARS = 12000


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def script_root() -> Path:
    # .codex/hooks/codex_memory.py -> workspace root
    return Path(__file__).resolve().parents[2]


def memory_root() -> Path:
    root = script_root()
    override = os.environ.get("CODEX_MEMORY_ROOT")
    if override:
        candidate = Path(override)
        if not candidate.is_absolute():
            candidate = root / candidate
        return candidate.resolve()

    if (root / "MEMORY.md").exists() or (root / "memory").exists():
        return root

    gio = root / "gio-workspace"
    if (gio / "MEMORY.md").exists() or (gio / "memory").exists():
        return gio.resolve()

    return root


def hooks_log_dir() -> Path:
    path = script_root() / ".codex" / "hooks" / "logs"
    path.mkdir(parents=True, exist_ok=True)
    return path


def read_stdin_json() -> dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {"raw": data}
    except json.JSONDecodeError:
        return {"raw_stdin": raw[:4000]}


def append_jsonl(name: str, entry: dict[str, Any]) -> None:
    try:
        path = hooks_log_dir() / name
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, ensure_ascii=True) + "\n")
        try:
            path.chmod(0o666)
        except OSError:
            pass
    except OSError:
        pass


def log_error(stage: str, err: Exception | str, extra: dict[str, Any] | None = None) -> None:
    try:
        payload: dict[str, Any] = {
            "timestamp": utc_now(),
            "stage": stage,
            "error": str(err),
        }
        if extra:
            payload.update(extra)
        append_jsonl("errors.jsonl", payload)
    except Exception:
        pass


def read_text(path: Path, limit: int = 6000) -> str:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    if len(text) > limit:
        return text[:limit] + "\n...[truncated]"
    return text


def compact_text(text: str, limit: int) -> str:
    cleaned = re.sub(r"\s+\n", "\n", text).strip()
    if len(cleaned) <= limit:
        return cleaned
    return cleaned[:limit].rstrip() + "\n...[truncated]"


def tokenize(text: str) -> set[str]:
    return {t.lower() for t in re.findall(r"[A-Za-z0-9][A-Za-z0-9_-]{2,}", text)}


def markdown_files(root: Path) -> list[Path]:
    files: list[Path] = []
    if (root / "MEMORY.md").exists():
        files.append(root / "MEMORY.md")
    mem_dir = root / "memory"
    if mem_dir.exists():
        for path in mem_dir.rglob("*.md"):
            if "_archive" not in path.parts:
                files.append(path)
    return files


def local_memory_search(query: str, limit: int = 5) -> list[dict[str, str]]:
    root = memory_root()
    query_tokens = tokenize(query)
    if not query_tokens:
        return []

    scored: list[tuple[int, Path, str]] = []
    for path in markdown_files(root):
        text = read_text(path, limit=12000)
        if not text:
            continue
        haystack = tokenize(path.name + " " + text)
        overlap = query_tokens & haystack
        if not overlap:
            continue
        score = len(overlap) * 10
        score += len(query_tokens & tokenize(path.stem)) * 5
        scored.append((score, path, text))

    scored.sort(key=lambda item: item[0], reverse=True)
    results = []
    for score, path, text in scored[:limit]:
        try:
            source = str(path.relative_to(root)).replace("\\", "/")
        except ValueError:
            source = str(path)
        results.append(
            {
                "title": path.stem.replace("-", " ").title(),
                "source": source,
                "score": str(score),
                "text": compact_text(text, 1200),
            }
        )
    return results


def load_core_memory() -> str:
    root = memory_root()
    sections: list[str] = []

    index = read_text(root / "MEMORY.md", limit=4500)
    if index:
        sections.append("## MEMORY.md\n" + index)

    budget = MAX_CONTEXT_CHARS - sum(len(s) for s in sections)
    for subdir in ("identity", "knowledge", "procedures"):
        folder = root / "memory" / subdir
        if not folder.exists():
            continue
        for path in sorted(folder.glob("*.md")):
            if budget <= 1200:
                break
            text = read_text(path, limit=min(3000, budget))
            if not text:
                continue
            try:
                rel = str(path.relative_to(root)).replace("\\", "/")
            except ValueError:
                rel = str(path)
            block = f"## {rel}\n{text}"
            sections.append(block)
            budget -= len(block)

    endpoint = weaviate_url()
    ready = "ready" if weaviate_ready(endpoint) else "not ready"
    sections.append(
        "## Weaviate\n"
        f"Project: {PROJECT}\n"
        f"URL selected by hook: {endpoint}\n"
        f"Health: {ready}\n"
        "Do not use the older vasari_weaviate endpoint on 8081 for live Vasari-BOS memory."
    )
    return compact_text("\n\n".join(sections), MAX_CONTEXT_CHARS)


def is_docker() -> bool:
    return Path("/.dockerenv").exists() or bool(os.environ.get("KUBERNETES_SERVICE_HOST"))


def weaviate_url() -> str:
    override = os.environ.get("CODEX_MEMORY_WEAVIATE_URL")
    if override:
        return override.rstrip("/")
    if is_docker():
        return DOCKER_WEAVIATE_URL
    if platform.system().lower().startswith("win"):
        return LOCAL_WEAVIATE_URL
    return HOST_WEAVIATE_URL


def http_json(method: str, url: str, payload: dict[str, Any] | None = None, timeout: float = 2.0) -> dict[str, Any]:
    data = None
    headers = {"Accept": "application/json"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = Request(url, data=data, method=method.upper(), headers=headers)
    with urlopen(req, timeout=timeout) as resp:
        body = resp.read().decode("utf-8", errors="replace")
    if not body:
        return {}
    return json.loads(body)


def weaviate_ready(base_url: str) -> bool:
    try:
        req = Request(base_url.rstrip("/") + "/v1/.well-known/ready", method="GET")
        with urlopen(req, timeout=1.0) as resp:
            return 200 <= resp.status < 300
    except Exception:
        return False


def ensure_weaviate_schema(base_url: str) -> None:
    cache = hooks_log_dir() / ".weaviate-schema-ok"
    try:
        if cache.exists() and (time.time() - cache.stat().st_mtime) < 86400:
            return
    except OSError:
        pass

    schema = {
        "class": CLASS_NAME,
        "description": "Codex cognitive memory entries for Vasari-BOS",
        "vectorizer": "none",
        "properties": [
            {"name": "title", "dataType": ["text"]},
            {"name": "text", "dataType": ["text"]},
            {"name": "source", "dataType": ["text"]},
            {"name": "project", "dataType": ["text"]},
            {"name": "kind", "dataType": ["text"]},
            {"name": "cwd", "dataType": ["text"]},
            {"name": "session_id", "dataType": ["text"]},
            {"name": "turn_id", "dataType": ["text"]},
            {"name": "tags", "dataType": ["text"]},
            {"name": "stability", "dataType": ["text"]},
            {"name": "created_at", "dataType": ["date"]},
            {"name": "updated_at", "dataType": ["date"]},
        ],
    }
    try:
        current = http_json("GET", base_url.rstrip("/") + "/v1/schema", timeout=5.0)
        for klass in current.get("classes", []):
            if klass.get("class") == CLASS_NAME:
                cache.write_text(utc_now(), encoding="utf-8")
                return
        http_json("POST", base_url.rstrip("/") + "/v1/schema", schema, timeout=5.0)
        cache.write_text(utc_now(), encoding="utf-8")
    except Exception as exc:
        log_error("ensure_weaviate_schema", exc)


def ingest_memory(kind: str, title: str, text: str, source: str, input_data: dict[str, Any]) -> bool:
    base_url = weaviate_url()
    if not weaviate_ready(base_url):
        return False
    ensure_weaviate_schema(base_url)

    session_id = str(input_data.get("session_id") or input_data.get("conversation_id") or "unknown")
    turn_id = str(input_data.get("turn_id") or input_data.get("run_id") or "")
    now = utc_now()
    obj = {
        "class": CLASS_NAME,
        "id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"{PROJECT}:{kind}:{source}:{session_id}:{turn_id}:{title}:{now[:19]}")),
        "properties": {
            "title": title,
            "text": compact_text(text, 6000),
            "source": source,
            "project": PROJECT,
            "kind": kind,
            "cwd": str(input_data.get("cwd") or os.getcwd()),
            "session_id": session_id,
            "turn_id": turn_id,
            "tags": "codex,memory,vasari-bos",
            "stability": "episodic" if kind in {"episode", "compact"} else "stable",
            "created_at": now,
            "updated_at": now,
        },
    }
    try:
        http_json("POST", base_url.rstrip("/") + "/v1/objects", obj, timeout=2.0)
        return True
    except Exception as exc:
        log_error("ingest_memory", exc, {"kind": kind, "title": title})
        return False


def graphql_string(value: str) -> str:
    return json.dumps(value)[1:-1]


def weaviate_bm25(query_text: str, limit: int = 5) -> list[dict[str, str]]:
    base_url = weaviate_url()
    if not query_text.strip() or not weaviate_ready(base_url):
        return []
    ensure_weaviate_schema(base_url)

    gql = f"""
    {{
      Get {{
        {CLASS_NAME}(
          limit: {limit}
          bm25: {{ query: "{graphql_string(query_text[:500])}" }}
          where: {{
            path: ["project"]
            operator: Equal
            valueText: "{graphql_string(PROJECT)}"
          }}
        ) {{
          title
          text
          source
          kind
          updated_at
          _additional {{ score }}
        }}
      }}
    }}
    """
    try:
        response = http_json("POST", base_url.rstrip("/") + "/v1/graphql", {"query": gql}, timeout=3.0)
        rows = response.get("data", {}).get("Get", {}).get(CLASS_NAME, []) or []
    except Exception as exc:
        log_error("weaviate_bm25", exc)
        return []

    results: list[dict[str, str]] = []
    for row in rows:
        results.append(
            {
                "title": str(row.get("title") or "Weaviate memory"),
                "source": str(row.get("source") or "weaviate"),
                "kind": str(row.get("kind") or "memory"),
                "score": str((row.get("_additional") or {}).get("score") or ""),
                "text": compact_text(str(row.get("text") or ""), 1200),
            }
        )
    return results


def prompt_from_input(input_data: dict[str, Any]) -> str:
    candidates = [
        input_data.get("prompt"),
        input_data.get("user_prompt"),
        input_data.get("userPrompt"),
        input_data.get("message"),
        input_data.get("input"),
    ]
    for candidate in candidates:
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    for key in ("tool_input", "payload"):
        nested = input_data.get(key)
        if isinstance(nested, dict):
            nested_prompt = prompt_from_input(nested)
            if nested_prompt:
                return nested_prompt
    return ""


def emit_context(event_name: str, context: str, approve: bool = False) -> None:
    if not context.strip():
        return
    output: dict[str, Any] = {
        "hookSpecificOutput": {
            "hookEventName": event_name,
            "additionalContext": compact_text(context, MAX_CONTEXT_CHARS),
        }
    }
    if approve:
        output["decision"] = "approve"
    print(json.dumps(output, ensure_ascii=True))


def session_start(input_data: dict[str, Any]) -> None:
    append_jsonl("session-start.jsonl", {"timestamp": utc_now(), "input": compact_hook_input(input_data)})
    context = "# Vasari-BOS cognitive memory\n\n" + load_core_memory()
    emit_context("SessionStart", context)


def prompt_submit(input_data: dict[str, Any]) -> None:
    prompt = prompt_from_input(input_data)
    append_jsonl(
        "prompts.jsonl",
        {
            "timestamp": utc_now(),
            "session_id": input_data.get("session_id"),
            "prompt": compact_text(prompt, 1200),
        },
    )
    if not prompt:
        return

    local_results = local_memory_search(prompt, limit=5)
    weaviate_results = weaviate_bm25(prompt, limit=5)
    sections: list[str] = []
    if local_results:
        sections.append("## Local markdown memory")
        for item in local_results:
            sections.append(f"### {item['source']}\n{item['text']}")
    if weaviate_results:
        sections.append("## Weaviate recall")
        for item in weaviate_results:
            sections.append(f"### {item['title']} ({item['source']})\n{item['text']}")
    if not sections:
        return
    context = "# Vasari-BOS prompt-relevant memory\n\n" + "\n\n".join(sections)
    emit_context("UserPromptSubmit", context, approve=True)


def compact_hook_input(input_data: dict[str, Any]) -> dict[str, Any]:
    compact: dict[str, Any] = {}
    for key in ("session_id", "conversation_id", "turn_id", "cwd", "hook_event_name", "transcript_path"):
        if key in input_data:
            compact[key] = input_data[key]
    prompt = prompt_from_input(input_data)
    if prompt:
        compact["prompt"] = compact_text(prompt, 1200)
    for key in ("summary", "last_assistant_message"):
        value = input_data.get(key)
        if isinstance(value, str) and value.strip():
            compact[key] = compact_text(value, 1200)
    return compact


def latest_prompt() -> str:
    path = hooks_log_dir() / "prompts.jsonl"
    if not path.exists():
        return ""
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return ""
    for line in reversed(lines[-50:]):
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        prompt = entry.get("prompt")
        if isinstance(prompt, str) and prompt.strip():
            return prompt.strip()
    return ""


def append_episode(title: str, text: str, input_data: dict[str, Any]) -> None:
    root = memory_root()
    folder = root / "memory" / "episodes"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / (datetime.now(timezone.utc).strftime("%Y-%m-%d") + ".md")
    stamp = datetime.now(timezone.utc).strftime("%H:%MZ")
    session_id = str(input_data.get("session_id") or input_data.get("conversation_id") or "unknown")
    line = f"\n- {stamp} - {title} (`{session_id[:12]}`): {compact_text(text, 500).replace(chr(10), ' ')}\n"
    with path.open("a", encoding="utf-8") as handle:
        if path.stat().st_size == 0:
            handle.write(f"# {datetime.now(timezone.utc).strftime('%Y-%m-%d')}\n")
        handle.write(line)
    try:
        path.chmod(0o666)
    except OSError:
        pass


def stop(input_data: dict[str, Any]) -> None:
    compact = compact_hook_input(input_data)
    compact["timestamp"] = utc_now()
    append_jsonl("stop-events.jsonl", compact)

    prompt = latest_prompt()
    summary = compact.get("summary") or compact.get("last_assistant_message") or ""
    if prompt and not summary:
        summary = f"Session ended after prompt: {prompt}"
    elif prompt and summary:
        summary = f"Last prompt: {prompt}\n\nSession note: {summary}"
    if not summary:
        summary = "Codex session ended in Vasari-BOS."

    try:
        append_episode("Codex session ended", summary, input_data)
    except Exception as exc:
        log_error("append_episode", exc)

    ingest_memory("episode", "Codex session ended", summary, "codex-hook:stop", input_data)


def post_compact(input_data: dict[str, Any]) -> None:
    compact = compact_hook_input(input_data)
    compact["timestamp"] = utc_now()
    append_jsonl("compact-events.jsonl", compact)

    text = compact.get("summary") or compact.get("last_assistant_message") or "Codex context compacted."
    ingest_memory("compact", "Codex context compacted", str(text), "codex-hook:post-compact", input_data)


def main() -> int:
    action = (sys.argv[1] if len(sys.argv) > 1 else "").strip().lower()
    input_data = read_stdin_json()
    try:
        if action in {"session-start", "sessionstart", "start"}:
            session_start(input_data)
        elif action in {"prompt-submit", "userpromptsubmit", "prompt"}:
            prompt_submit(input_data)
        elif action == "stop":
            stop(input_data)
        elif action in {"post-compact", "postcompact", "compact"}:
            post_compact(input_data)
        else:
            log_error("main", f"unknown action: {action}")
    except (HTTPError, URLError, OSError, Exception) as exc:
        log_error(action or "main", exc, {"input": compact_hook_input(input_data)})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
