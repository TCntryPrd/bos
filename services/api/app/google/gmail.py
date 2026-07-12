"""Direct Gmail API client using stored OAuth tokens."""

import httpx
import base64
from .oauth import get_valid_token

GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me"


def _headers() -> dict:
    token = get_valid_token("gmail")
    if not token:
        raise ConnectionError("Gmail not connected. Complete OAuth setup first.")
    return {"Authorization": f"Bearer {token}"}


def get_unread_messages(max_results: int = 10) -> list[dict]:
    """Get recent unread messages."""
    with httpx.Client(timeout=15) as client:
        resp = client.get(
            f"{GMAIL_API}/messages",
            headers=_headers(),
            params={"q": "is:unread", "maxResults": max_results},
        )
        resp.raise_for_status()

    message_ids = [m["id"] for m in resp.json().get("messages", [])]
    messages = []

    with httpx.Client(timeout=15) as client:
        for msg_id in message_ids[:max_results]:
            resp = client.get(
                f"{GMAIL_API}/messages/{msg_id}",
                headers=_headers(),
                # metadataHeaders must be repeated per field, not comma-joined
                params=[
                    ("format", "metadata"),
                    ("metadataHeaders", "From"),
                    ("metadataHeaders", "Subject"),
                    ("metadataHeaders", "Date"),
                ],
            )
            if resp.status_code != 200:
                continue
            data = resp.json()
            headers = {h["name"]: h["value"] for h in data.get("payload", {}).get("headers", [])}
            messages.append({
                "id": msg_id,
                "from": headers.get("From", ""),
                "subject": headers.get("Subject", ""),
                "date": headers.get("Date", ""),
                "snippet": data.get("snippet", ""),
            })

    return messages


def send_email(to: str, subject: str, body: str, email: str | None = None) -> dict:
    """Send an email via Gmail API."""
    import base64
    from email.mime.text import MIMEText

    token = get_valid_token("gmail", email)
    if not token:
        raise ConnectionError("Gmail not connected.")

    msg = MIMEText(body)
    msg["to"] = to
    msg["subject"] = subject
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()

    with httpx.Client(timeout=15) as client:
        resp = client.post(
            f"{GMAIL_API}/messages/send",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json={"raw": raw},
        )
        resp.raise_for_status()
    return resp.json()


def delete_message(message_id: str, email: str | None = None) -> dict:
    """Move a message to trash."""
    token = get_valid_token("gmail", email)
    if not token:
        raise ConnectionError("Gmail not connected.")
    with httpx.Client(timeout=15) as client:
        resp = client.post(f"{GMAIL_API}/messages/{message_id}/trash", headers={"Authorization": f"Bearer {token}"})
        resp.raise_for_status()
    return {"id": message_id, "trashed": True}


def mark_read(message_id: str, email: str | None = None) -> dict:
    """Mark a message as read."""
    token = get_valid_token("gmail", email)
    if not token:
        raise ConnectionError("Gmail not connected.")
    with httpx.Client(timeout=15) as client:
        resp = client.post(
            f"{GMAIL_API}/messages/{message_id}/modify",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json={"removeLabelIds": ["UNREAD"]},
        )
        resp.raise_for_status()
    return {"id": message_id, "marked_read": True}


def reply_to_message(message_id: str, body_text: str, email: str | None = None) -> dict:
    """Reply to an email."""
    import base64 as b64
    from email.mime.text import MIMEText

    token = get_valid_token("gmail", email)
    if not token:
        raise ConnectionError("Gmail not connected.")

    # Get original message for headers
    with httpx.Client(timeout=15) as client:
        resp = client.get(
            f"{GMAIL_API}/messages/{message_id}",
            headers={"Authorization": f"Bearer {token}"},
            params=[
                ("format", "metadata"),
                ("metadataHeaders", "From"),
                ("metadataHeaders", "Subject"),
                ("metadataHeaders", "Message-ID"),
            ],
        )
        resp.raise_for_status()
    orig = resp.json()
    headers = {h["name"]: h["value"] for h in orig.get("payload", {}).get("headers", [])}
    thread_id = orig.get("threadId")

    msg = MIMEText(body_text)
    msg["to"] = headers.get("From", "")
    msg["subject"] = "Re: " + headers.get("Subject", "")
    msg["In-Reply-To"] = headers.get("Message-ID", "")
    msg["References"] = headers.get("Message-ID", "")
    raw = b64.urlsafe_b64encode(msg.as_bytes()).decode()

    with httpx.Client(timeout=15) as client:
        resp = client.post(
            f"{GMAIL_API}/messages/send",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json={"raw": raw, "threadId": thread_id},
        )
        resp.raise_for_status()
    return resp.json()


def get_message_body(message_id: str) -> str:
    """Get full message body."""
    with httpx.Client(timeout=15) as client:
        resp = client.get(f"{GMAIL_API}/messages/{message_id}", headers=_headers())
        resp.raise_for_status()

    data = resp.json()
    payload = data.get("payload", {})

    # Try to get plain text body
    for part in payload.get("parts", [payload]):
        if part.get("mimeType") == "text/plain":
            body_data = part.get("body", {}).get("data", "")
            if body_data:
                return base64.urlsafe_b64decode(body_data).decode("utf-8", errors="replace")

    return data.get("snippet", "")
