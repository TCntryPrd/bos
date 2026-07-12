from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

import httpx

from .config import get_settings
from .db import get_runtime_config_value


@dataclass
class UnipileRuntimeConfig:
    base_url: str
    api_key: str


def load_unipile_runtime_config() -> UnipileRuntimeConfig:
    settings = get_settings()
    runtime_base_url = get_runtime_config_value(["UNIPILE_BASE_URL", "UNIPILE_API_URL", "UNIPILE_DSN"])
    runtime_key = get_runtime_config_value(["UNIPILE_API_KEY", "UNIPILE_TOKEN"])
    return UnipileRuntimeConfig(
        base_url=settings.normalized_base_url(runtime_base_url),
        api_key=settings.api_key(runtime_key),
    )


class UnipileClient:
    def __init__(self) -> None:
        self.runtime = load_unipile_runtime_config()

    @property
    def configured(self) -> bool:
        return bool(self.runtime.base_url and self.runtime.api_key)

    async def request(self, method: str, path: str, **kwargs: Any) -> Any:
        if not self.configured:
            raise RuntimeError("Unipile is not configured")
        headers = kwargs.pop("headers", {})
        headers["X-API-KEY"] = self.runtime.api_key
        headers.setdefault("accept", "application/json")
        url = f"{self.runtime.base_url.rstrip('/')}/api/v1/{path.lstrip('/')}"
        async with httpx.AsyncClient(timeout=20.0) as client:
            response = await client.request(method, url, headers=headers, **kwargs)
        if response.status_code >= 400:
            body = response.text[:500]
            raise RuntimeError(f"Unipile HTTP {response.status_code}: {body}")
        return response.json() if response.content else None

    async def list_accounts(self) -> list[dict[str, Any]]:
        data = await self.request("GET", "/accounts?limit=250")
        return data.get("items", []) if isinstance(data, dict) else []

    async def get_own_profile(self, account_id: str) -> dict[str, Any]:
        data = await self.request("GET", "/users/me", params={"account_id": account_id})
        return data if isinstance(data, dict) else {}

    async def list_user_posts(self, account_id: str, identifier: str, limit: int = 25) -> dict[str, Any]:
        safe_limit = min(max(int(limit or 25), 1), 100)
        data = await self.request(
            "GET",
            f"/users/{quote(identifier, safe='')}/posts",
            params={"account_id": account_id, "limit": safe_limit},
        )
        return data if isinstance(data, dict) else {"items": []}

    async def list_webhooks(self) -> list[dict[str, Any]]:
        data = await self.request("GET", "/webhooks")
        if isinstance(data, dict):
            if isinstance(data.get("items"), list):
                return data["items"]
            if isinstance(data.get("webhooks"), list):
                return data["webhooks"]
        return data if isinstance(data, list) else []

    async def create_webhook(self, payload: dict[str, Any]) -> dict[str, Any]:
        data = await self.request("POST", "/webhooks", json=payload, headers={"content-type": "application/json"})
        return data if isinstance(data, dict) else {}

    async def send_chat_message(self, chat_id: str, text: str, account_id: str | None = None) -> dict[str, Any]:
        files: dict[str, tuple[None, str]] = {"text": (None, text)}
        if account_id:
            files["account_id"] = (None, account_id)
        data = await self.request("POST", f"/chats/{chat_id}/messages", files=files)
        return data if isinstance(data, dict) else {}

    async def start_linkedin_chat(self, account_id: str, attendee_provider_id: str, text: str) -> dict[str, Any]:
        files: dict[str, tuple[None, str]] = {
            "account_id": (None, account_id),
            "text": (None, text),
            "attendees_ids": (None, attendee_provider_id),
            "linkedin[api]": (None, "classic"),
        }
        data = await self.request("POST", "/chats", files=files)
        return data if isinstance(data, dict) else {}

    async def create_linkedin_post(
        self,
        account_id: str,
        text: str,
        external_link: str | None = None,
        media: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        files: list[tuple[str, tuple[str | None, bytes | str, str | None] | tuple[None, str]]] = [
            ("account_id", (None, account_id)),
            ("text", (None, text)),
        ]
        if external_link:
            files.append(("external_link", (None, external_link)))
        async with httpx.AsyncClient(timeout=30.0) as client:
            for index, item in enumerate(media or []):
                url = str(item.get("url") or item.get("preview_url") or "").strip()
                if not url:
                    continue
                response = await client.get(url)
                response.raise_for_status()
                filename = str(item.get("file_name") or item.get("filename") or f"linkedin-media-{index + 1}")
                content_type = response.headers.get("content-type") or item.get("mimetype") or "application/octet-stream"
                files.append(("attachments", (filename, response.content, str(content_type))))
        data = await self.request("POST", "/posts", files=files)
        return data if isinstance(data, dict) else {}
