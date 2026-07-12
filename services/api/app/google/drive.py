"""Direct Google Drive API client using stored OAuth tokens."""

import httpx
import mimetypes
from pathlib import Path
from .oauth import get_valid_token

DRIVE_API = "https://www.googleapis.com/drive/v3"
DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3"


def _headers(email: str | None = None) -> dict:
    token = get_valid_token("drive", email)
    if not token:
        raise ConnectionError("Google Drive not connected.")
    return {"Authorization": f"Bearer {token}"}


def search_files(query: str, email: str | None = None, max_results: int = 10) -> list[dict]:
    """Search Drive files. Query uses Google Drive query syntax."""
    with httpx.Client(timeout=15) as client:
        resp = client.get(
            f"{DRIVE_API}/files",
            headers=_headers(email),
            params={
                "q": query,
                "pageSize": max_results,
                "fields": "files(id,name,mimeType,modifiedTime,webViewLink)",
            },
        )
        resp.raise_for_status()
    return resp.json().get("files", [])


def find_by_name(name: str, email: str | None = None) -> list[dict]:
    """Find files by name (partial match)."""
    return search_files(f"name contains '{name}' and trashed = false", email)


def find_spreadsheet(name: str, email: str | None = None) -> list[dict]:
    """Find spreadsheets by name."""
    return search_files(
        f"name contains '{name}' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false",
        email,
    )


def find_document(name: str, email: str | None = None) -> list[dict]:
    """Find docs by name."""
    return search_files(
        f"name contains '{name}' and mimeType = 'application/vnd.google-apps.document' and trashed = false",
        email,
    )


def delete_file(file_id: str, email: str | None = None) -> dict:
    """Move a file to trash."""
    with httpx.Client(timeout=15) as client:
        resp = client.patch(
            f"{DRIVE_API}/files/{file_id}",
            headers={**_headers(email), "Content-Type": "application/json"},
            json={"trashed": True},
        )
        resp.raise_for_status()
    return {"id": file_id, "trashed": True}


def rename_file(file_id: str, new_name: str, email: str | None = None) -> dict:
    """Rename a file."""
    with httpx.Client(timeout=15) as client:
        resp = client.patch(
            f"{DRIVE_API}/files/{file_id}",
            headers={**_headers(email), "Content-Type": "application/json"},
            json={"name": new_name},
        )
        resp.raise_for_status()
    return {"id": file_id, "name": new_name}


def upload_file(file_path: str, name: str | None = None, folder_id: str | None = None,
                mime_type: str | None = None, email: str | None = None) -> dict:
    """Upload a local file to Google Drive. Returns file ID and web link."""
    token = get_valid_token("drive", email)
    if not token:
        raise ConnectionError("Google Drive not connected.")

    path = Path(file_path)
    if not path.exists():
        raise FileNotFoundError(f"File not found: {file_path}")

    file_name = name or path.name
    content_type = mime_type or mimetypes.guess_type(str(path))[0] or "application/octet-stream"

    # Metadata
    metadata = {"name": file_name}
    if folder_id:
        metadata["parents"] = [folder_id]

    # Multipart upload
    import json
    boundary = "boss_upload_boundary"
    body = (
        f"--{boundary}\r\n"
        f"Content-Type: application/json; charset=UTF-8\r\n\r\n"
        f"{json.dumps(metadata)}\r\n"
        f"--{boundary}\r\n"
        f"Content-Type: {content_type}\r\n\r\n"
    ).encode() + path.read_bytes() + f"\r\n--{boundary}--".encode()

    with httpx.Client(timeout=60) as client:
        resp = client.post(
            f"{DRIVE_UPLOAD_API}/files",
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": f"multipart/related; boundary={boundary}",
            },
            params={"uploadType": "multipart", "fields": "id,name,mimeType,webViewLink,webContentLink"},
            content=body,
        )
        resp.raise_for_status()

    data = resp.json()
    return {
        "id": data.get("id"),
        "name": data.get("name"),
        "mimeType": data.get("mimeType"),
        "webViewLink": data.get("webViewLink"),
        "webContentLink": data.get("webContentLink"),
    }


def upload_bytes(content: bytes, name: str, mime_type: str, folder_id: str | None = None,
                 email: str | None = None) -> dict:
    """Upload raw bytes to Google Drive. Returns file ID and web link."""
    token = get_valid_token("drive", email)
    if not token:
        raise ConnectionError("Google Drive not connected.")

    import json
    metadata = {"name": name}
    if folder_id:
        metadata["parents"] = [folder_id]

    boundary = "boss_upload_boundary"
    body = (
        f"--{boundary}\r\n"
        f"Content-Type: application/json; charset=UTF-8\r\n\r\n"
        f"{json.dumps(metadata)}\r\n"
        f"--{boundary}\r\n"
        f"Content-Type: {mime_type}\r\n\r\n"
    ).encode() + content + f"\r\n--{boundary}--".encode()

    with httpx.Client(timeout=60) as client:
        resp = client.post(
            f"{DRIVE_UPLOAD_API}/files",
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": f"multipart/related; boundary={boundary}",
            },
            params={"uploadType": "multipart", "fields": "id,name,mimeType,webViewLink,webContentLink"},
            content=body,
        )
        resp.raise_for_status()

    data = resp.json()
    return {
        "id": data.get("id"),
        "name": data.get("name"),
        "mimeType": data.get("mimeType"),
        "webViewLink": data.get("webViewLink"),
        "webContentLink": data.get("webContentLink"),
    }
