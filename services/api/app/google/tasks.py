"""Direct Google Tasks API client using stored OAuth tokens."""

import httpx
from .oauth import get_valid_token

TASKS_API = "https://tasks.googleapis.com/tasks/v1"


def _headers() -> dict:
    token = get_valid_token("tasks")
    if not token:
        raise ConnectionError("Google Tasks not connected. Complete OAuth setup first.")
    return {"Authorization": f"Bearer {token}"}


def get_task_lists() -> list[dict]:
    """Get all task lists."""
    with httpx.Client(timeout=15) as client:
        resp = client.get(f"{TASKS_API}/users/@me/lists", headers=_headers())
        resp.raise_for_status()
    return [{"id": t["id"], "title": t["title"]} for t in resp.json().get("items", [])]


def get_pending_tasks(tasklist_id: str = "@default") -> list[dict]:
    """Get pending (not completed) tasks from a list."""
    with httpx.Client(timeout=15) as client:
        resp = client.get(
            f"{TASKS_API}/lists/{tasklist_id}/tasks",
            headers=_headers(),
            params={"showCompleted": "false", "showHidden": "false"},
        )
        resp.raise_for_status()

    return [
        {
            "id": t["id"],
            "title": t.get("title", ""),
            "notes": t.get("notes", ""),
            "due": t.get("due"),
            "status": t.get("status"),
        }
        for t in resp.json().get("items", [])
        if t.get("title")
    ]


def create_task(title: str, notes: str = "", tasklist_id: str = "@default") -> dict:
    """Create a new task."""
    with httpx.Client(timeout=15) as client:
        resp = client.post(
            f"{TASKS_API}/lists/{tasklist_id}/tasks",
            headers={**_headers(), "Content-Type": "application/json"},
            json={"title": title, "notes": notes},
        )
        resp.raise_for_status()

    data = resp.json()
    return {"id": data["id"], "title": data["title"], "status": data.get("status")}


def update_task(task_id: str, updates: dict, tasklist_id: str = "@default", email: str | None = None) -> dict:
    """Update a task. updates can include: title, notes, due, status."""
    token = get_valid_token("tasks", email)
    if not token:
        raise ConnectionError("Google Tasks not connected.")
    with httpx.Client(timeout=15) as client:
        resp = client.patch(
            f"{TASKS_API}/lists/{tasklist_id}/tasks/{task_id}",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json=updates,
        )
        resp.raise_for_status()
    data = resp.json()
    return {"id": data["id"], "title": data.get("title"), "status": data.get("status")}


def complete_task(task_id: str, tasklist_id: str = "@default", email: str | None = None) -> dict:
    """Mark a task as completed."""
    return update_task(task_id, {"status": "completed"}, tasklist_id, email)


def delete_task(task_id: str, tasklist_id: str = "@default", email: str | None = None) -> dict:
    """Delete a task."""
    token = get_valid_token("tasks", email)
    if not token:
        raise ConnectionError("Google Tasks not connected.")
    with httpx.Client(timeout=15) as client:
        resp = client.delete(
            f"{TASKS_API}/lists/{tasklist_id}/tasks/{task_id}",
            headers={"Authorization": f"Bearer {token}"},
        )
        resp.raise_for_status()
    return {"id": task_id, "deleted": True}
