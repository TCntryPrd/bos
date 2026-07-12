import asyncio
from typing import Any

from .config import get_settings
from .unipile_client import UnipileClient


def webhook_payload(source: str, public_base_url: str, webhook_secret: str) -> dict[str, Any]:
    return {
        "source": source,
        "request_url": f"{public_base_url.rstrip('/')}/webhooks/unipile/{source}",
        "name": f"vasari-{source}",
        "headers": [
            {"key": "Content-Type", "value": "application/json"},
            {"key": "Unipile-Auth", "value": webhook_secret},
        ],
    }


async def main() -> None:
    settings = get_settings()
    client = UnipileClient()
    sources = ["messaging", "users", "account_status"]
    if not settings.public_base_url or not settings.webhook_secret or not client.configured:
        print("Webhook registration not attempted. Missing PUBLIC_BASE_URL, WEBHOOK_SECRET, or Unipile config.")
        for source in sources:
            print(webhook_payload(source, settings.public_base_url or "https://<public-host>", "<WEBHOOK_SECRET>"))
        return

    existing = await client.list_webhooks()
    for source in sources:
        payload = webhook_payload(source, settings.public_base_url, settings.webhook_secret)
        request_url = payload["request_url"]
        found = any(
            item.get("source") == source and item.get("request_url") == request_url
            for item in existing
            if isinstance(item, dict)
        )
        if found:
            print({"source": source, "status": "exists"})
            continue
        created = await client.create_webhook(payload)
        print({"source": source, "status": "created", "id": created.get("id")})


def run() -> None:
    asyncio.run(main())
