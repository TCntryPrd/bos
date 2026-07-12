"""Direct Google Docs API client using stored OAuth tokens."""

import httpx
from .oauth import get_valid_token

DOCS_API = "https://docs.googleapis.com/v1/documents"


def _headers(email: str | None = None) -> dict:
    token = get_valid_token("docs", email)
    if not token:
        raise ConnectionError("Google Docs not connected.")
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def get_document(doc_id: str, email: str | None = None) -> dict:
    with httpx.Client(timeout=15) as client:
        resp = client.get(f"{DOCS_API}/{doc_id}", headers=_headers(email))
        resp.raise_for_status()
    return resp.json()


def append_text(doc_id: str, text: str, email: str | None = None) -> dict:
    """Append text to the end of a document."""
    # First get the doc to find the end index
    doc = get_document(doc_id, email)
    end_index = doc.get("body", {}).get("content", [{}])[-1].get("endIndex", 1) - 1
    if end_index < 1:
        end_index = 1

    with httpx.Client(timeout=15) as client:
        resp = client.post(
            f"{DOCS_API}/{doc_id}:batchUpdate",
            headers=_headers(email),
            json={
                "requests": [
                    {
                        "insertText": {
                            "location": {"index": end_index},
                            "text": text,
                        }
                    }
                ]
            },
        )
        resp.raise_for_status()
    return resp.json()


def create_document(title: str, body_text: str = "", email: str | None = None) -> dict:
    """Create a new Google Doc."""
    with httpx.Client(timeout=15) as client:
        resp = client.post(
            DOCS_API,
            headers=_headers(email),
            json={"title": title},
        )
        resp.raise_for_status()
        doc = resp.json()

    if body_text:
        append_text(doc["documentId"], body_text, email)

    return {"id": doc["documentId"], "title": doc["title"]}
