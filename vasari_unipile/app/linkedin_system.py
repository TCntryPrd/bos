import asyncio
import random
from datetime import date, datetime, time, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from .config import get_settings
from .db import connect
from .unipile_client import UnipileClient

DEFAULT_POST_ACCEPT_MESSAGE = (
    "Thanks for connecting, {first_name}. I appreciate it. "
    "I share practical notes from the work here: what is working, what is not, "
    "and what I am learning along the way. Glad to be connected."
)

CAP_BY_ACTION = {
    "invite_no_note": "cap_invite_no_note_per_day",
    "invite_with_note": "cap_invite_with_note_per_day",
    "post_accept_message": "cap_message_per_day",
    "message": "cap_message_per_day",
    "profile_view": "cap_profile_view_per_day",
    "comment": "cap_comment_per_day",
    "reaction": "cap_reaction_per_day",
    "follow": "cap_follow_per_day",
    "publish_post": "cap_publish_post_per_day",
}

POST_SYNC_MINUTES = 15


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return str(value)


def _first_name(full_name: str | None) -> str:
    if not full_name:
        return "there"
    first = full_name.strip().split(" ")[0].strip()
    return first or "there"


def _provider(value: Any) -> str:
    raw = str(value or "").upper()
    if "LINKEDIN" in raw:
        return "LINKEDIN"
    if "WHATSAPP" in raw:
        return "WHATSAPP"
    if "INSTAGRAM" in raw:
        return "INSTAGRAM"
    if "TELEGRAM" in raw:
        return "TELEGRAM"
    return raw or "UNKNOWN"


def _account_provider(account: dict[str, Any]) -> str:
    return _provider(account.get("type") or account.get("account_type") or account.get("provider"))


def _account_health(account: dict[str, Any] | None) -> str:
    if not account:
        return "not_connected"
    status = account.get("status") or account.get("health")
    if status:
        return str(status)
    source_statuses = []
    for source in account.get("sources") or []:
        raw_status = source.get("status") if isinstance(source, dict) else None
        if isinstance(raw_status, dict):
            raw_status = raw_status.get("status") or raw_status.get("message")
        if raw_status:
            source_statuses.append(str(raw_status))
    return ", ".join(source_statuses) if source_statuses else "OK"


def _display_name(account: dict[str, Any]) -> str | None:
    for key in ("name", "username", "email", "display_name"):
        if account.get(key):
            return str(account[key])
    return None


def _cap_for(action_type: str) -> int:
    settings = get_settings()
    attr = CAP_BY_ACTION.get(action_type, "cap_message_per_day")
    return int(getattr(settings, attr, settings.cap_message_per_day))


def _cap_rows() -> list[dict[str, Any]]:
    today = date.today().isoformat()
    return [
        {"action_type": action, "day": today, "count": 0, "cap": _cap_for(action)}
        for action in sorted(CAP_BY_ACTION)
    ]


def _render_template(template: str, profile: dict[str, Any]) -> str:
    full_name = profile.get("full_name") or profile.get("user_full_name")
    values = {
        "first_name": _first_name(str(full_name) if full_name else None),
        "full_name": full_name or "there",
        "role": profile.get("headline") or profile.get("current_role_title") or "",
        "company": profile.get("current_company") or "",
    }
    rendered = template
    for key, value in values.items():
        rendered = rendered.replace("{" + key + "}", str(value))
    return rendered.strip()


def _next_work_start(now: datetime | None = None) -> datetime:
    settings = get_settings()
    tz = ZoneInfo(settings.timezone)
    current = (now or _utcnow()).astimezone(tz)
    start = time(hour=max(0, min(settings.work_hours_start, 23)), tzinfo=tz)
    candidate = datetime.combine(current.date(), start)
    if candidate <= current:
        candidate = candidate + timedelta(days=1)
    return candidate.astimezone(timezone.utc)


def _inside_work_hours(now: datetime | None = None) -> bool:
    settings = get_settings()
    current = (now or _utcnow()).astimezone(ZoneInfo(settings.timezone))
    return settings.work_hours_start <= current.hour < settings.work_hours_end


def _random_action_delay() -> timedelta:
    settings = get_settings()
    low = max(0, settings.min_action_gap_seconds)
    high = max(low, settings.max_action_gap_seconds)
    return timedelta(seconds=random.randint(low, high))


def _as_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def ensure_default_campaign(conn: Any, account_id: int) -> dict[str, Any]:
    row = conn.execute(
        """
        SELECT id, templates, daily_caps, status, created_at
          FROM unipile.campaign
         WHERE account_id = %s
           AND is_default = true
         LIMIT 1
        """,
        (account_id,),
    ).fetchone()
    if row:
        templates = dict(row.get("templates") or {})
        changed = False
        if not templates.get("post_accept_message"):
            templates["post_accept_message"] = DEFAULT_POST_ACCEPT_MESSAGE
            changed = True
        if "auto_send_post_accept" not in templates:
            templates["auto_send_post_accept"] = False
            changed = True
        if changed:
            row = conn.execute(
                """
                UPDATE unipile.campaign
                   SET templates = %s
                 WHERE id = %s
                 RETURNING id, templates, daily_caps, status, created_at
                """,
                (Jsonb(templates), row["id"]),
            ).fetchone()
        return dict(row)

    templates = {
        "post_accept_message": DEFAULT_POST_ACCEPT_MESSAGE,
        "auto_send_post_accept": False,
    }
    return dict(
        conn.execute(
            """
            INSERT INTO unipile.campaign (
              account_id, name, templates, daily_caps, status, is_default
            )
            VALUES (%s, 'Default LinkedIn follow-up', %s, %s, 'active', true)
            RETURNING id, templates, daily_caps, status, created_at
            """,
            (
                account_id,
                Jsonb(templates),
                Jsonb({"post_accept_message": _cap_for("post_accept_message")}),
            ),
        ).fetchone()
    )


def _upsert_account(conn: Any, account: dict[str, Any]) -> dict[str, Any] | None:
    unipile_account_id = str(account.get("id") or account.get("account_id") or "").strip()
    if not unipile_account_id:
        return None
    provider = _account_provider(account)
    status = _account_health(account)
    row = conn.execute(
        """
        INSERT INTO unipile.account (
          unipile_account_id, provider, display_name, status, last_status_at, raw
        )
        VALUES (%s, %s, %s, %s, now(), %s)
        ON CONFLICT (unipile_account_id) DO UPDATE SET
          provider = EXCLUDED.provider,
          display_name = COALESCE(EXCLUDED.display_name, unipile.account.display_name),
          status = EXCLUDED.status,
          last_status_at = now(),
          raw = EXCLUDED.raw
        RETURNING id, unipile_account_id, provider, display_name, status, last_status_at, created_at
        """,
        (
            unipile_account_id,
            provider,
            _display_name(account),
            status,
            Jsonb(account),
        ),
    ).fetchone()
    if row and provider == "LINKEDIN":
        ensure_default_campaign(conn, int(row["id"]))
    return dict(row) if row else None


def _account_from_event(conn: Any, payload: dict[str, Any]) -> dict[str, Any]:
    account_status = payload.get("AccountStatus") if isinstance(payload.get("AccountStatus"), dict) else {}
    account_id = str(payload.get("account_id") or account_status.get("account_id") or "").strip()
    provider = _provider(payload.get("account_type") or account_status.get("account_type") or "LINKEDIN")
    status = str(account_status.get("message") or payload.get("status") or "OK")
    row = conn.execute(
        """
        INSERT INTO unipile.account (
          unipile_account_id, provider, status, last_status_at, raw
        )
        VALUES (%s, %s, %s, now(), %s)
        ON CONFLICT (unipile_account_id) DO UPDATE SET
          provider = EXCLUDED.provider,
          status = EXCLUDED.status,
          last_status_at = now(),
          raw = unipile.account.raw || EXCLUDED.raw
        RETURNING id, unipile_account_id, provider, display_name, status, last_status_at, created_at
        """,
        (account_id or "unknown-linkedin-account", provider, status, Jsonb(payload)),
    ).fetchone()
    if provider == "LINKEDIN":
        ensure_default_campaign(conn, int(row["id"]))
    return dict(row)


async def sync_accounts() -> list[dict[str, Any]]:
    client = UnipileClient()
    if not client.configured:
        return []
    accounts = await client.list_accounts()
    rows: list[dict[str, Any]] = []
    with connect() as conn:
        for account in accounts:
            row = _upsert_account(conn, account)
            if row:
                rows.append(row)
        conn.commit()
    return rows


def _normalize_media(attachments: Any) -> list[dict[str, Any]]:
    media: list[dict[str, Any]] = []
    if not isinstance(attachments, list):
        return media
    for item in attachments:
        if not isinstance(item, dict):
            continue
        raw_type = str(item.get("type") or "").lower()
        media_type = "image" if raw_type in {"img", "image"} else "video" if raw_type == "video" else "file"
        url = str(item.get("url") or "").strip()
        if not url or item.get("unavailable") is True:
            continue
        media.append(
            {
                "id": item.get("id"),
                "type": media_type,
                "raw_type": raw_type,
                "url": url,
                "preview_url": url,
                "mimetype": item.get("mimetype"),
                "file_name": item.get("file_name") or item.get("filename"),
                "size": item.get("size"),
                "url_expires_at": item.get("url_expires_at"),
            }
        )
    return media


def _first_image_media(posts: list[dict[str, Any]]) -> dict[str, Any] | None:
    for post in posts:
        for item in _normalize_media(post.get("attachments")):
            if item.get("type") == "image":
                return {**item, "source_post_id": post.get("social_id") or post.get("id")}
    return None


def _source_post_cards(posts: list[dict[str, Any]], limit: int = 3) -> list[dict[str, Any]]:
    cards: list[dict[str, Any]] = []
    for post in posts[:limit]:
        cards.append(
            {
                "social_id": post.get("social_id"),
                "share_url": post.get("share_url"),
                "text": str(post.get("text") or "")[:800],
                "parsed_datetime": post.get("parsed_datetime"),
                "media": _normalize_media(post.get("attachments")),
            }
        )
    return cards


def _draft_text_from_posts(posts: list[dict[str, Any]]) -> str:
    latest = next((str(post.get("text") or "").strip() for post in posts if str(post.get("text") or "").strip()), "")
    hook = latest.split("\n", 1)[0].strip() if latest else "Burnout is not coming from the workload."
    hook = hook[:160].rstrip(".") + "."
    return (
        f"{hook}\n\n"
        "It is coming from this:\n\n"
        "• Every approval\n"
        "• Every client question\n"
        "• Every manual task\n"
        "• Every interruption\n"
        "• Every decision that should already have a path\n\n"
        "None of them feel big.\n\n"
        "Together they destroy momentum.\n\n"
        "That is why I automate decisions before I automate work.\n\n"
        "Not because automation is magic.\n\n"
        "Because repeated decisions are where time, context, and energy quietly leak."
    )


def _ensure_starter_post_draft(conn: Any, account_id: int, posts: list[dict[str, Any]]) -> dict[str, Any] | None:
    existing = conn.execute(
        """
        SELECT id, action_type, status, payload, not_before, attempts, last_error, created_at, executed_at
          FROM unipile.action_queue
         WHERE account_id = %s
           AND action_type = 'publish_post'
           AND status IN ('needs_review','queued','running')
         ORDER BY created_at DESC
         LIMIT 1
        """,
        (account_id,),
    ).fetchone()
    if existing:
        payload = dict(existing.get("payload") or {})
        payload.setdefault("draft_title", "Recent work lesson")
        payload.setdefault("source", "linkedin_recent_posts")
        payload.setdefault(
            "approval_note",
            "Starter draft created from recent LinkedIn themes. Review tone and media before publishing.",
        )
        payload.setdefault(
            "content_series",
            {
                "name": "AI in the Trenches",
                "promise": "What worked, what did not, and what surprised us while building real systems.",
                "trust_message": "Show judgment in the messy middle, not just finished automation screenshots.",
                "messy_middle": True,
            },
        )
        if not payload.get("media"):
            media = _first_image_media(posts)
            payload["media"] = [media] if media else []
        payload["source_posts"] = _source_post_cards(posts)
        row = conn.execute(
            """
            UPDATE unipile.action_queue
               SET payload = %s
             WHERE id = %s
               AND status IN ('needs_review','queued','running')
             RETURNING id, action_type, status, payload, not_before, attempts, last_error, created_at, executed_at
            """,
            (Jsonb(payload), existing["id"]),
        ).fetchone()
        return dict(row) if row else dict(existing)

    media = _first_image_media(posts)
    payload = {
        "draft_title": "Recent work lesson",
        "text": _draft_text_from_posts(posts),
        "media": [media] if media else [],
        "source": "linkedin_recent_posts",
        "source_posts": _source_post_cards(posts),
        "content_series": {
            "name": "AI in the Trenches",
            "promise": "What worked, what did not, and what surprised us while building real systems.",
            "trust_message": "Show judgment in the messy middle, not just finished automation screenshots.",
            "messy_middle": True,
        },
        "approval_note": "Starter draft created from recent LinkedIn themes. Review tone and media before publishing.",
    }
    row = conn.execute(
        """
        INSERT INTO unipile.action_queue (
          account_id, action_type, payload, priority, not_before, status, dedupe_key, created_by
        )
        VALUES (%s, 'publish_post', %s, 40, now(), 'needs_review', %s, 'linkedin_system:starter_draft')
        ON CONFLICT (dedupe_key) DO UPDATE SET
          payload = EXCLUDED.payload,
          status = CASE
            WHEN unipile.action_queue.status IN ('needs_review','queued') THEN unipile.action_queue.status
            ELSE EXCLUDED.status
          END
        RETURNING id, action_type, status, payload, not_before, attempts, last_error, created_at, executed_at
        """,
        (account_id, Jsonb(payload), f"starter_publish_post:{account_id}"),
    ).fetchone()
    return dict(row) if row else None


async def sync_linkedin_posts(limit: int = 25) -> dict[str, Any]:
    rows = await sync_accounts()
    account = next((row for row in rows if row.get("provider") == "LINKEDIN"), None)
    with connect() as conn:
        if not account:
            account = _linkedin_account(conn)
        if not account:
            return {"ok": False, "upserted": 0, "draft": None, "error": "LinkedIn account has not synced"}
        account_id = int(account["id"])
        unipile_account_id = str(account["unipile_account_id"])

    client = UnipileClient()
    me = await client.get_own_profile(unipile_account_id)
    identifier = str(me.get("provider_id") or me.get("public_identifier") or "").strip()
    if not identifier:
        return {"ok": False, "upserted": 0, "draft": None, "error": "LinkedIn owner identifier unavailable"}
    post_data = await client.list_user_posts(unipile_account_id, identifier, limit)
    items = post_data.get("items", []) if isinstance(post_data, dict) else []
    if not isinstance(items, list):
        items = []

    with connect() as conn:
        row = conn.execute(
            """
            UPDATE unipile.account
               SET public_identifier = COALESCE(%s, public_identifier),
                   member_urn = COALESCE(%s, member_urn),
                   display_name = COALESCE(%s, display_name),
                   raw = COALESCE(raw, '{}'::jsonb) || %s,
                   last_status_at = now()
             WHERE id = %s
             RETURNING id
            """,
            (
                me.get("public_identifier"),
                me.get("provider_id") or me.get("entity_urn") or me.get("object_urn"),
                " ".join([str(me.get("first_name") or "").strip(), str(me.get("last_name") or "").strip()]).strip() or None,
                Jsonb({"owner_profile": me}),
                account_id,
            ),
        ).fetchone()
        if not row:
            raise RuntimeError("LinkedIn account row disappeared during sync")

        upserted = 0
        for post in items:
            if not isinstance(post, dict):
                continue
            social_id = str(post.get("social_id") or post.get("id") or "").strip()
            if not social_id:
                continue
            author = post.get("author") if isinstance(post.get("author"), dict) else {}
            written_by = post.get("written_by") if isinstance(post.get("written_by"), dict) else {}
            conn.execute(
                """
                INSERT INTO unipile.post (
                  account_id, social_id, linkedin_id, share_url, is_owned,
                  author_provider_id, author_name, author_is_company, text,
                  posted_at, reaction_counter, comment_counter, repost_counter,
                  impressions_counter, permissions, attachments, raw, last_polled_at
                )
                VALUES (%s, %s, %s, %s, true, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now())
                ON CONFLICT (account_id, social_id) DO UPDATE SET
                  linkedin_id = EXCLUDED.linkedin_id,
                  share_url = EXCLUDED.share_url,
                  is_owned = true,
                  author_provider_id = EXCLUDED.author_provider_id,
                  author_name = EXCLUDED.author_name,
                  author_is_company = EXCLUDED.author_is_company,
                  text = EXCLUDED.text,
                  posted_at = EXCLUDED.posted_at,
                  reaction_counter = EXCLUDED.reaction_counter,
                  comment_counter = EXCLUDED.comment_counter,
                  repost_counter = EXCLUDED.repost_counter,
                  impressions_counter = EXCLUDED.impressions_counter,
                  permissions = EXCLUDED.permissions,
                  attachments = EXCLUDED.attachments,
                  raw = EXCLUDED.raw,
                  last_polled_at = now()
                """,
                (
                    account_id,
                    social_id,
                    post.get("id"),
                    post.get("share_url"),
                    author.get("id") or written_by.get("id"),
                    author.get("name") or written_by.get("name"),
                    author.get("is_company"),
                    post.get("text"),
                    post.get("parsed_datetime"),
                    post.get("reaction_counter"),
                    post.get("comment_counter"),
                    post.get("repost_counter"),
                    post.get("impressions_counter"),
                    Jsonb(post.get("permissions") or {}),
                    Jsonb(post.get("attachments") or []),
                    Jsonb(post),
                ),
            )
            upserted += 1

        draft = _ensure_starter_post_draft(conn, account_id, [p for p in items if isinstance(p, dict)])
        conn.execute(
            """
            INSERT INTO unipile.audit_log (actor, action, entity_type, entity_id, detail)
            VALUES ('vasari_unipile_worker', 'linkedin_posts_synced', 'account', %s, %s)
            """,
            (str(account_id), Jsonb({"upserted": upserted, "owner_identifier": identifier, "cursor": post_data.get("cursor")})),
        )
        conn.commit()
        return {"ok": True, "upserted": upserted, "draft": draft, "owner": me}


async def sync_linkedin_posts_if_due(limit: int = 25) -> dict[str, Any]:
    if not UnipileClient().configured:
        return {"ok": True, "skipped": True, "reason": "unipile_not_configured"}
    with connect() as conn:
        account = _linkedin_account(conn)
        account_id = int(account["id"]) if account else None
        due = True if not account_id else _post_sync_due(conn, account_id)
    if not due:
        return {"ok": True, "skipped": True, "reason": "fresh"}
    return await sync_linkedin_posts(limit)


def _post_sync_due(conn: Any, account_id: int | None) -> bool:
    if not account_id:
        return False
    post_row = conn.execute(
        "SELECT count(*)::int AS count FROM unipile.post WHERE account_id = %s",
        (account_id,),
    ).fetchone()
    if not post_row or int(post_row["count"]) == 0:
        return True
    audit_row = conn.execute(
        """
        SELECT created_at
          FROM unipile.audit_log
         WHERE actor = 'vasari_unipile_worker'
           AND action = 'linkedin_posts_synced'
           AND entity_type = 'account'
           AND entity_id = %s
         ORDER BY created_at DESC
         LIMIT 1
        """,
        (str(account_id),),
    ).fetchone()
    if not audit_row:
        return True
    return (_utcnow() - audit_row["created_at"]) > timedelta(minutes=POST_SYNC_MINUTES)


def _linkedin_account(conn: Any) -> dict[str, Any] | None:
    row = conn.execute(
        """
        SELECT id, unipile_account_id, provider, display_name, public_identifier,
               connections_count, status, last_status_at, created_at
          FROM unipile.account
         WHERE provider = 'LINKEDIN'
         ORDER BY last_status_at DESC NULLS LAST, created_at DESC
         LIMIT 1
        """
    ).fetchone()
    return dict(row) if row else None


def _post_accept_message(conn: Any, account_id: int | None) -> dict[str, Any]:
    if not account_id:
        return {
            "campaign_id": None,
            "message": DEFAULT_POST_ACCEPT_MESSAGE,
            "auto_send": False,
            "status": "inactive",
        }
    campaign = ensure_default_campaign(conn, account_id)
    templates = dict(campaign.get("templates") or {})
    return {
        "campaign_id": campaign.get("id"),
        "message": templates.get("post_accept_message") or DEFAULT_POST_ACCEPT_MESSAGE,
        "auto_send": _as_bool(templates.get("auto_send_post_accept")),
        "status": campaign.get("status") or "active",
    }


def _query_optional(conn: Any, sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
    try:
        return [dict(row) for row in conn.execute(sql, params).fetchall()]
    except Exception:
        return []


def _linkedin_posts(conn: Any, account_id: int | None, limit: int = 30) -> list[dict[str, Any]]:
    posts: list[dict[str, Any]] = []
    boss_table = conn.execute("SELECT to_regclass('public.boss_linkedin_posts') AS table_name").fetchone()
    if boss_table and boss_table.get("table_name"):
        posts.extend(
            _query_optional(
                conn,
                """
                SELECT id::text, 'boss' AS source, text, link, post_id,
                       CASE
                         WHEN post_id IS NOT NULL AND post_id <> ''
                         THEN 'https://www.linkedin.com/feed/update/' || post_id || '/'
                         ELSE NULL
                       END AS share_url,
                       media_kind, posted_at,
                       NULL::integer AS reaction_counter,
                       NULL::integer AS comment_counter,
                       NULL::integer AS repost_counter,
                       NULL::integer AS impressions_counter,
                       '[]'::jsonb AS attachments
                  FROM boss_linkedin_posts
                 ORDER BY posted_at DESC
                 LIMIT %s
                """,
                (limit,),
            )
        )
    if account_id:
        posts.extend(
            _query_optional(
                conn,
                """
                SELECT id::text, 'unipile' AS source, text, NULL::text AS link,
                       COALESCE(social_id, linkedin_id) AS post_id, share_url,
                       NULL::text AS media_kind, posted_at,
                       reaction_counter, comment_counter, repost_counter,
                       impressions_counter, attachments
                  FROM unipile.post
                 WHERE account_id = %s
                 ORDER BY posted_at DESC NULLS LAST, id DESC
                 LIMIT %s
                """,
                (account_id, limit),
            )
        )
    posts.sort(key=lambda item: str(item.get("posted_at") or ""), reverse=True)
    return [
        {
            **item,
            "posted_at": _iso(item.get("posted_at")),
            "media": _normalize_media(item.get("attachments")),
        }
        for item in posts[:limit]
    ]


def _counts(conn: Any, account_id: int | None) -> dict[str, Any]:
    if not account_id:
        return {
            "posts": 0,
            "connections_found": 0,
            "connections_connected": 0,
            "requests_sent": 0,
            "requests_pending": 0,
            "requests_accepted": 0,
            "messages": 0,
            "queued_actions": 0,
            "review_actions": 0,
            "failed_actions": 0,
            "webhooks_last_24h": 0,
        }
    row = conn.execute(
        """
        SELECT
          (SELECT count(*)::int FROM unipile.profile WHERE account_id = %s) AS connections_found,
          (SELECT count(*)::int FROM unipile.connection WHERE account_id = %s) AS connections_connected,
          (SELECT count(*)::int FROM unipile.invitation WHERE account_id = %s AND direction = 'sent') AS requests_sent,
          (SELECT count(*)::int FROM unipile.invitation WHERE account_id = %s AND direction = 'sent' AND status IN ('queued','sent','pending')) AS requests_pending,
          (SELECT count(*)::int FROM unipile.invitation WHERE account_id = %s AND status = 'accepted') AS requests_accepted,
          (SELECT count(*)::int FROM unipile.message WHERE account_id = %s) AS messages,
          (SELECT count(*)::int FROM unipile.action_queue WHERE account_id = %s AND status = 'queued') AS queued_actions,
          (SELECT count(*)::int FROM unipile.action_queue WHERE account_id = %s AND status = 'needs_review') AS review_actions,
          (SELECT count(*)::int FROM unipile.action_queue WHERE account_id = %s AND status = 'failed') AS failed_actions,
          (SELECT count(*)::int FROM unipile.webhook_event WHERE received_at >= now() - interval '24 hours') AS webhooks_last_24h
        """,
        (account_id, account_id, account_id, account_id, account_id, account_id, account_id, account_id, account_id),
    ).fetchone()
    return dict(row)


def _stage_counts(conn: Any, account_id: int | None) -> dict[str, int]:
    if not account_id:
        return {}
    rows = conn.execute(
        """
        SELECT stage, count(*)::int AS count
          FROM unipile.prospect
         WHERE account_id = %s
         GROUP BY stage
         ORDER BY stage
        """,
        (account_id,),
    ).fetchall()
    return {str(row["stage"]): int(row["count"]) for row in rows}


def _recent_profiles(conn: Any, account_id: int | None) -> list[dict[str, Any]]:
    if not account_id:
        return []
    rows = conn.execute(
        """
        SELECT p.id, p.provider_id, p.full_name, p.headline, p.current_company,
               p.profile_url, p.public_profile_url, p.picture_url, p.network_distance,
               p.first_seen_at, c.connected_at, pr.stage, pr.next_action, pr.next_action_at
          FROM unipile.profile p
          LEFT JOIN unipile.connection c ON c.profile_id = p.id AND c.account_id = p.account_id
          LEFT JOIN unipile.prospect pr ON pr.profile_id = p.id AND pr.account_id = p.account_id
         WHERE p.account_id = %s
         ORDER BY COALESCE(c.connected_at, p.first_seen_at) DESC
         LIMIT 20
        """,
        (account_id,),
    ).fetchall()
    return [
        {
            **dict(row),
            "first_seen_at": _iso(row.get("first_seen_at")),
            "connected_at": _iso(row.get("connected_at")),
            "next_action_at": _iso(row.get("next_action_at")),
        }
        for row in rows
    ]


def _recent_invitations(conn: Any, account_id: int | None) -> list[dict[str, Any]]:
    if not account_id:
        return []
    rows = conn.execute(
        """
        SELECT i.id, i.provider_id, i.direction, i.status, i.has_note,
               i.sent_at, i.responded_at, i.created_at, p.full_name, p.profile_url
          FROM unipile.invitation i
          LEFT JOIN unipile.profile p ON p.id = i.profile_id
         WHERE i.account_id = %s
         ORDER BY COALESCE(i.responded_at, i.sent_at, i.created_at) DESC
         LIMIT 20
        """,
        (account_id,),
    ).fetchall()
    return [
        {
            **dict(row),
            "sent_at": _iso(row.get("sent_at")),
            "responded_at": _iso(row.get("responded_at")),
            "created_at": _iso(row.get("created_at")),
        }
        for row in rows
    ]


def _webhook_summary(conn: Any) -> list[dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT source, COALESCE(event_type, source) AS event_type,
               count(*)::int AS count,
               count(*) FILTER (WHERE processing_status IN ('pending','received','processing'))::int AS pending,
               max(received_at) AS last_received_at,
               max(processed_at) AS last_processed_at
          FROM unipile.webhook_event
         GROUP BY source, COALESCE(event_type, source)
         ORDER BY max(received_at) DESC NULLS LAST
         LIMIT 30
        """
    ).fetchall()
    return [
        {
            **dict(row),
            "last_received_at": _iso(row.get("last_received_at")),
            "last_processed_at": _iso(row.get("last_processed_at")),
        }
        for row in rows
    ]


def _queue_summary(conn: Any, account_id: int | None) -> dict[str, Any]:
    if not account_id:
        return {"status_counts": {}, "ready": 0, "budgets": _cap_rows(), "recent": []}
    status_rows = conn.execute(
        """
        SELECT status, count(*)::int AS count
          FROM unipile.action_queue
         WHERE account_id = %s
         GROUP BY status
         ORDER BY status
        """,
        (account_id,),
    ).fetchall()
    budget_rows = conn.execute(
        """
        SELECT action_type, day, count, cap, updated_at
          FROM unipile.rate_budget_ledger
         WHERE account_id = %s
           AND day = CURRENT_DATE
         ORDER BY action_type
        """,
        (account_id,),
    ).fetchall()
    budget_by_action = {row["action_type"]: dict(row) for row in budget_rows}
    budgets = []
    for default in _cap_rows():
        item = budget_by_action.get(default["action_type"], default)
        budgets.append(
            {
                **item,
                "day": _iso(item.get("day")),
                "updated_at": _iso(item.get("updated_at")),
            }
        )
    recent_rows = conn.execute(
        """
        SELECT id, action_type, status, payload, priority, not_before,
               attempts, last_error, created_by, created_at, executed_at
          FROM unipile.action_queue
         WHERE account_id = %s
         ORDER BY created_at DESC
         LIMIT 20
        """,
        (account_id,),
    ).fetchall()
    ready = conn.execute(
        """
        SELECT count(*)::int AS count
          FROM unipile.action_queue
         WHERE account_id = %s
           AND status = 'queued'
           AND not_before <= now()
        """,
        (account_id,),
    ).fetchone()
    return {
        "status_counts": {str(row["status"]): int(row["count"]) for row in status_rows},
        "ready": int(ready["count"] if ready else 0),
        "budgets": budgets,
        "recent": [
            {
                **dict(row),
                "not_before": _iso(row.get("not_before")),
                "created_at": _iso(row.get("created_at")),
                "executed_at": _iso(row.get("executed_at")),
            }
            for row in recent_rows
        ],
    }


def _pending_post_draft(conn: Any, account_id: int | None) -> dict[str, Any] | None:
    if not account_id:
        return None
    row = conn.execute(
        """
        SELECT id, action_type, status, payload, priority, not_before,
               attempts, last_error, created_by, created_at, executed_at
          FROM unipile.action_queue
         WHERE account_id = %s
           AND action_type = 'publish_post'
           AND status IN ('needs_review','queued','running')
         ORDER BY
           CASE status
             WHEN 'needs_review' THEN 0
             WHEN 'queued' THEN 1
             ELSE 2
           END,
           created_at DESC
         LIMIT 1
        """,
        (account_id,),
    ).fetchone()
    if not row:
        return None
    item = dict(row)
    item["not_before"] = _iso(item.get("not_before"))
    item["created_at"] = _iso(item.get("created_at"))
    item["executed_at"] = _iso(item.get("executed_at"))
    return item


def _proof_summary(conn: Any, account: dict[str, Any] | None, posts: list[dict[str, Any]]) -> dict[str, Any]:
    account_id = int(account["id"]) if account else None
    last_sync = None
    posts_loaded = 0
    posts_with_media = 0
    latest_post_at = None
    latest_media_url = None
    if account_id:
        row = conn.execute(
            """
            SELECT count(*)::int AS posts_loaded,
                   count(*) FILTER (
                     WHERE jsonb_typeof(COALESCE(attachments, '[]'::jsonb)) = 'array'
                       AND jsonb_array_length(COALESCE(attachments, '[]'::jsonb)) > 0
                   )::int AS posts_with_media,
                   max(posted_at) AS latest_post_at
              FROM unipile.post
             WHERE account_id = %s
            """,
            (account_id,),
        ).fetchone()
        if row:
            posts_loaded = int(row["posts_loaded"] or 0)
            posts_with_media = int(row["posts_with_media"] or 0)
            latest_post_at = row.get("latest_post_at")
        sync_row = conn.execute(
            """
            SELECT created_at, detail
              FROM unipile.audit_log
             WHERE actor = 'vasari_unipile_worker'
               AND action = 'linkedin_posts_synced'
               AND entity_type = 'account'
               AND entity_id = %s
             ORDER BY created_at DESC
             LIMIT 1
            """,
            (str(account_id),),
        ).fetchone()
        if sync_row:
            last_sync = sync_row.get("created_at")
    for post in posts:
        media = post.get("media") if isinstance(post.get("media"), list) else []
        first = next((item for item in media if isinstance(item, dict) and item.get("url")), None)
        if first:
            latest_media_url = first.get("url")
            break
    return {
        "owner_public_identifier": account.get("public_identifier") if account else None,
        "account_display_name": account.get("display_name") if account else None,
        "posts_loaded": posts_loaded,
        "posts_visible": len(posts),
        "posts_with_media": posts_with_media,
        "latest_post_at": _iso(latest_post_at),
        "last_posts_sync_at": _iso(last_sync),
        "latest_media_url": latest_media_url,
        "pending_draft_id": None,
    }


def _worker_status(conn: Any) -> dict[str, Any]:
    row = conn.execute(
        """
        SELECT created_at
          FROM unipile.audit_log
         WHERE actor = 'vasari_unipile_worker'
           AND action = 'heartbeat'
         ORDER BY created_at DESC
         LIMIT 1
        """
    ).fetchone()
    last = row.get("created_at") if row else None
    running = bool(last and (_utcnow() - last) < timedelta(minutes=10))
    return {
        "running": running,
        "last_heartbeat_at": _iso(last),
        "status": "online" if running else "waiting_for_heartbeat",
    }


async def linkedin_overview() -> dict[str, Any]:
    sync_error: str | None = None
    try:
        await sync_accounts()
    except Exception as exc:
        sync_error = str(exc)
    try:
        await sync_linkedin_posts_if_due()
    except Exception as exc:
        sync_error = f"{sync_error}; {exc}" if sync_error else str(exc)

    client = UnipileClient()
    with connect() as conn:
        account = _linkedin_account(conn)
        account_id = int(account["id"]) if account else None
        message = _post_accept_message(conn, account_id)
        posts = _linkedin_posts(conn, account_id)
        stats = _counts(conn, account_id)
        stats["posts"] = len(posts)
        pending_draft = _pending_post_draft(conn, account_id)
        proof = _proof_summary(conn, account, posts)
        if pending_draft:
            proof["pending_draft_id"] = pending_draft.get("id")
        overview = {
            "configured": client.configured,
            "sync_error": sync_error,
            "account": account,
            "agent": _worker_status(conn),
            "proof": proof,
            "stats": stats,
            "post_accept_message": message,
            "posts": posts,
            "pending_draft": pending_draft,
            "connections": {
                "stage_counts": _stage_counts(conn, account_id),
                "recent": _recent_profiles(conn, account_id),
            },
            "invitations": {
                "recent": _recent_invitations(conn, account_id),
            },
            "webhooks": _webhook_summary(conn),
            "queue": _queue_summary(conn, account_id),
            "checked_at": _iso(_utcnow()),
        }
        conn.commit()
        return overview


def update_post_accept_message(message: str, auto_send: bool | None = None) -> dict[str, Any]:
    clean = message.strip()
    if not clean:
        raise ValueError("message is required")
    if len(clean) > 2000:
        raise ValueError("message is too long")
    with connect() as conn:
        account = _linkedin_account(conn)
        if not account:
            raise ValueError("LinkedIn account has not synced yet")
        campaign = ensure_default_campaign(conn, int(account["id"]))
        templates = dict(campaign.get("templates") or {})
        templates["post_accept_message"] = clean
        if auto_send is not None:
            templates["auto_send_post_accept"] = bool(auto_send)
        row = conn.execute(
            """
            UPDATE unipile.campaign
               SET templates = %s
             WHERE id = %s
             RETURNING id, templates, status
            """,
            (Jsonb(templates), campaign["id"]),
        ).fetchone()
        conn.execute(
            """
            INSERT INTO unipile.audit_log (actor, action, entity_type, entity_id, detail)
            VALUES ('vasari-bos', 'post_accept_message_updated', 'campaign', %s, %s)
            """,
            (str(campaign["id"]), Jsonb({"auto_send": templates.get("auto_send_post_accept", False)})),
        )
        conn.commit()
        return {
            "campaign_id": row["id"],
            "message": templates["post_accept_message"],
            "auto_send": _as_bool(templates.get("auto_send_post_accept")),
            "status": row["status"],
        }


def save_post_draft(payload: dict[str, Any]) -> dict[str, Any]:
    text = str(payload.get("text") or "").strip()
    if not text:
        raise ValueError("draft text is required")
    if len(text) > 3000:
        raise ValueError("draft text is too long")
    draft_title = str(payload.get("draft_title") or "GPT-reviewed LinkedIn draft").strip()[:160]
    approval_note = str(
        payload.get("approval_note")
        or "Draft saved by the LinkedIn GPT bridge. Review in Vasari before publishing."
    ).strip()[:500]
    requested_media = payload.get("media") if isinstance(payload.get("media"), list) else None
    requested_source_posts = payload.get("source_posts") if isinstance(payload.get("source_posts"), list) else None
    requested_email_context = payload.get("email_context") if isinstance(payload.get("email_context"), dict) else None
    requested_content_series = payload.get("content_series") if isinstance(payload.get("content_series"), dict) else None
    action_id = payload.get("action_id")
    with connect() as conn:
        account = _linkedin_account(conn)
        if not account:
            raise ValueError("LinkedIn account has not synced yet")
        account_id = int(account["id"])
        existing = None
        if action_id:
            existing = conn.execute(
                """
                SELECT id, payload
                  FROM unipile.action_queue
                 WHERE id = %s
                   AND account_id = %s
                   AND action_type = 'publish_post'
                   AND status NOT IN ('executed','cancelled')
                 LIMIT 1
                """,
                (int(action_id), account_id),
            ).fetchone()
        if not existing:
            existing = _pending_post_draft(conn, account_id)

        existing_payload = dict(existing.get("payload") or {}) if existing else {}
        media = requested_media if requested_media is not None else existing_payload.get("media", [])
        source_posts = requested_source_posts if requested_source_posts is not None else existing_payload.get("source_posts", [])
        email_context = requested_email_context if requested_email_context is not None else existing_payload.get("email_context")
        content_series = requested_content_series if requested_content_series is not None else existing_payload.get("content_series")
        next_payload = {
            **existing_payload,
            "draft_title": draft_title,
            "text": text,
            "media": [item for item in media if isinstance(item, dict)],
            "source": "linkedin_gpt_bridge",
            "source_posts": [item for item in source_posts if isinstance(item, dict)],
            "email_context": email_context if isinstance(email_context, dict) else None,
            "content_series": content_series if isinstance(content_series, dict) else None,
            "approval_note": approval_note,
            "external_link": payload.get("external_link") or existing_payload.get("external_link"),
            "updated_by": "linkedin_gpt_bridge",
            "updated_at": _iso(_utcnow()),
        }
        if existing:
            row = conn.execute(
                """
                UPDATE unipile.action_queue
                   SET payload = %s,
                       status = 'needs_review',
                       not_before = now(),
                       last_error = NULL
                 WHERE id = %s
                 RETURNING id, action_type, status, payload, not_before,
                           attempts, last_error, created_by, created_at, executed_at
                """,
                (Jsonb(next_payload), existing["id"]),
            ).fetchone()
        else:
            row = conn.execute(
                """
                INSERT INTO unipile.action_queue (
                  account_id, action_type, payload, priority, not_before, status, dedupe_key, created_by
                )
                VALUES (%s, 'publish_post', %s, 35, now(), 'needs_review', %s, 'linkedin_gpt_bridge')
                RETURNING id, action_type, status, payload, not_before,
                          attempts, last_error, created_by, created_at, executed_at
                """,
                (account_id, Jsonb(next_payload), f"gpt_publish_post:{account_id}:{int(_utcnow().timestamp())}"),
            ).fetchone()
        conn.execute(
            """
            INSERT INTO unipile.audit_log (actor, action, entity_type, entity_id, detail)
            VALUES ('linkedin_gpt_bridge', 'post_draft_saved', 'action_queue', %s, %s)
            """,
            (str(row["id"]), Jsonb({"draft_title": draft_title, "media_count": len(next_payload["media"])})),
        )
        conn.commit()
        result = dict(row)
        result["not_before"] = _iso(result.get("not_before"))
        result["created_at"] = _iso(result.get("created_at"))
        result["executed_at"] = _iso(result.get("executed_at"))
        return result


def approve_action(action_id: int) -> dict[str, Any]:
    with connect() as conn:
        row = conn.execute(
            """
            UPDATE unipile.action_queue
               SET status = 'queued',
                   not_before = now(),
                   last_error = NULL
             WHERE id = %s
               AND status IN ('needs_review','failed','queued')
             RETURNING id, action_type, status, payload, not_before, attempts, created_at
            """,
            (action_id,),
        ).fetchone()
        if not row:
            raise ValueError("action not found or cannot be approved")
        conn.execute(
            """
            INSERT INTO unipile.audit_log (actor, action, entity_type, entity_id, detail)
            VALUES ('vasari-bos', 'action_approved', 'action_queue', %s, %s)
            """,
            (str(action_id), Jsonb({"status": row["status"]})),
        )
        conn.commit()
        return dict(row)


def cancel_action(action_id: int) -> dict[str, Any]:
    with connect() as conn:
        row = conn.execute(
            """
            UPDATE unipile.action_queue
               SET status = 'cancelled'
             WHERE id = %s
               AND status NOT IN ('executed','cancelled')
             RETURNING id, action_type, status, payload, not_before, attempts, created_at
            """,
            (action_id,),
        ).fetchone()
        if not row:
            raise ValueError("action not found or cannot be cancelled")
        conn.execute(
            """
            INSERT INTO unipile.audit_log (actor, action, entity_type, entity_id, detail)
            VALUES ('vasari-bos', 'action_cancelled', 'action_queue', %s, %s)
            """,
            (str(action_id), Jsonb({"status": row["status"]})),
        )
        conn.commit()
        return dict(row)


def _mark_event(conn: Any, event_id: int, status: str, detail: dict[str, Any] | None = None) -> None:
    conn.execute(
        """
        UPDATE unipile.webhook_event
           SET processing_status = %s,
               processed_at = CASE WHEN %s IN ('processed','ignored','failed') THEN now() ELSE processed_at END
         WHERE id = %s
        """,
        (status, status, event_id),
    )
    if detail:
        conn.execute(
            """
            INSERT INTO unipile.audit_log (actor, action, entity_type, entity_id, detail)
            VALUES ('vasari_unipile_worker', 'webhook_' || %s, 'webhook_event', %s, %s)
            """,
            (status, str(event_id), Jsonb(detail)),
        )


def _upsert_profile(conn: Any, account_id: int, payload: dict[str, Any]) -> dict[str, Any] | None:
    provider_id = str(
        payload.get("user_provider_id")
        or payload.get("attendee_provider_id")
        or payload.get("provider_id")
        or ""
    ).strip()
    if not provider_id:
        return None
    full_name = (
        payload.get("user_full_name")
        or payload.get("attendee_name")
        or payload.get("full_name")
        or payload.get("name")
    )
    first = _first_name(str(full_name) if full_name else None)
    row = conn.execute(
        """
        INSERT INTO unipile.profile (
          account_id, provider_id, public_identifier, full_name, first_name,
          headline, profile_url, public_profile_url, picture_url, raw, last_enriched_at
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now())
        ON CONFLICT (account_id, provider_id) DO UPDATE SET
          public_identifier = COALESCE(EXCLUDED.public_identifier, unipile.profile.public_identifier),
          full_name = COALESCE(EXCLUDED.full_name, unipile.profile.full_name),
          first_name = COALESCE(EXCLUDED.first_name, unipile.profile.first_name),
          headline = COALESCE(EXCLUDED.headline, unipile.profile.headline),
          profile_url = COALESCE(EXCLUDED.profile_url, unipile.profile.profile_url),
          public_profile_url = COALESCE(EXCLUDED.public_profile_url, unipile.profile.public_profile_url),
          picture_url = COALESCE(EXCLUDED.picture_url, unipile.profile.picture_url),
          raw = unipile.profile.raw || EXCLUDED.raw,
          last_enriched_at = now()
        RETURNING id, account_id, provider_id, public_identifier, full_name, first_name,
                  headline, current_company, current_role_title, profile_url, picture_url
        """,
        (
            account_id,
            provider_id,
            payload.get("user_public_identifier") or payload.get("public_identifier"),
            full_name,
            first,
            payload.get("headline"),
            payload.get("user_profile_url") or payload.get("attendee_profile_url") or payload.get("profile_url"),
            payload.get("user_profile_url") or payload.get("public_profile_url"),
            payload.get("user_picture_url") or payload.get("picture_url"),
            Jsonb(payload),
        ),
    ).fetchone()
    return dict(row) if row else None


def _queue_post_accept_message(conn: Any, account: dict[str, Any], profile: dict[str, Any]) -> None:
    campaign = ensure_default_campaign(conn, int(account["id"]))
    templates = dict(campaign.get("templates") or {})
    template = str(templates.get("post_accept_message") or DEFAULT_POST_ACCEPT_MESSAGE).strip()
    if not template:
        return
    text = _render_template(template, profile)
    if not text:
        return
    auto_send = _as_bool(templates.get("auto_send_post_accept"))
    dedupe = f"post_accept_message:{account['id']}:{profile['provider_id']}"
    status = "queued" if auto_send else "needs_review"
    not_before = _utcnow() + (_random_action_delay() if auto_send else timedelta(seconds=0))
    payload = {
        "account_unipile_id": account.get("unipile_account_id"),
        "profile_id": profile.get("id"),
        "profile_provider_id": profile.get("provider_id"),
        "profile_full_name": profile.get("full_name"),
        "text": text,
        "source": "new_relation",
    }
    conn.execute(
        """
        INSERT INTO unipile.action_queue (
          account_id, action_type, payload, priority, not_before, status, dedupe_key, created_by
        )
        VALUES (%s, 'post_accept_message', %s, 50, %s, %s, %s, 'webhook:new_relation')
        ON CONFLICT (dedupe_key) DO NOTHING
        """,
        (account["id"], Jsonb(payload), not_before, status, dedupe),
    )


def _process_account_status(conn: Any, event_id: int, payload: dict[str, Any]) -> None:
    account = _account_from_event(conn, payload)
    _mark_event(conn, event_id, "processed", {"account_id": account.get("unipile_account_id"), "kind": "account_status"})


def _process_new_relation(conn: Any, event_id: int, payload: dict[str, Any]) -> None:
    if _provider(payload.get("account_type")) != "LINKEDIN":
        _mark_event(conn, event_id, "ignored", {"reason": "not_linkedin"})
        return
    account = _account_from_event(conn, payload)
    profile = _upsert_profile(conn, int(account["id"]), payload)
    if not profile:
        _mark_event(conn, event_id, "failed", {"reason": "missing_profile_id"})
        return
    conn.execute(
        """
        INSERT INTO unipile.connection (account_id, profile_id, source, connected_at)
        VALUES (%s, %s, 'webhook:new_relation', now())
        ON CONFLICT (account_id, profile_id) DO UPDATE SET
          connected_at = COALESCE(unipile.connection.connected_at, EXCLUDED.connected_at),
          source = EXCLUDED.source
        """,
        (account["id"], profile["id"]),
    )
    updated = conn.execute(
        """
        UPDATE unipile.invitation
           SET status = 'accepted',
               responded_at = now()
         WHERE account_id = %s
           AND provider_id = %s
           AND status <> 'accepted'
        """,
        (account["id"], profile["provider_id"]),
    )
    if updated.rowcount == 0:
        conn.execute(
            """
            INSERT INTO unipile.invitation (
              account_id, profile_id, provider_id, direction, status, responded_at
            )
            VALUES (%s, %s, %s, 'unknown', 'accepted', now())
            """,
            (account["id"], profile["id"], profile["provider_id"]),
        )
    campaign = ensure_default_campaign(conn, int(account["id"]))
    conn.execute(
        """
        INSERT INTO unipile.prospect (account_id, profile_id, campaign_id, stage, next_action)
        VALUES (%s, %s, %s, 'connected', 'post_accept_message')
        ON CONFLICT (account_id, profile_id, campaign_id) DO UPDATE SET
          stage = 'connected',
          stage_updated_at = now(),
          next_action = EXCLUDED.next_action
        """,
        (account["id"], profile["id"], campaign["id"]),
    )
    _queue_post_accept_message(conn, account, profile)
    _mark_event(conn, event_id, "processed", {"profile_provider_id": profile.get("provider_id"), "kind": "new_relation"})


def _process_message(conn: Any, event_id: int, payload: dict[str, Any]) -> None:
    if _provider(payload.get("account_type")) != "LINKEDIN":
        _mark_event(conn, event_id, "ignored", {"reason": "not_linkedin"})
        return
    account = _account_from_event(conn, payload)
    chat_id = str(payload.get("chat_id") or "").strip()
    message_id = str(payload.get("message_id") or payload.get("id") or "").strip()
    if not chat_id or not message_id:
        _mark_event(conn, event_id, "failed", {"reason": "missing_chat_or_message_id"})
        return
    sender = payload.get("sender") if isinstance(payload.get("sender"), dict) else {}
    provider_id = sender.get("attendee_provider_id") or sender.get("provider_id")
    sender_name = sender.get("attendee_name") or sender.get("name")
    account_info = payload.get("account_info") if isinstance(payload.get("account_info"), dict) else {}
    is_sender = bool(provider_id and provider_id == account_info.get("user_id"))
    chat_row = conn.execute(
        """
        INSERT INTO unipile.chat (
          account_id, unipile_chat_id, attendee_provider_id, name, is_group,
          last_message_at, raw
        )
        VALUES (%s, %s, %s, %s, false, %s, %s)
        ON CONFLICT (unipile_chat_id) DO UPDATE SET
          last_message_at = GREATEST(
            COALESCE(unipile.chat.last_message_at, EXCLUDED.last_message_at),
            EXCLUDED.last_message_at
          ),
          raw = unipile.chat.raw || EXCLUDED.raw
        RETURNING id
        """,
        (
            account["id"],
            chat_id,
            provider_id,
            sender_name,
            payload.get("timestamp"),
            Jsonb(payload),
        ),
    ).fetchone()
    if provider_id:
        _upsert_profile(
            conn,
            int(account["id"]),
            {
                "user_provider_id": provider_id,
                "user_full_name": sender_name,
                "user_profile_url": sender.get("attendee_profile_url"),
            },
        )
    conn.execute(
        """
        INSERT INTO unipile.message (
          account_id, chat_id, unipile_message_id, provider_id, sender_provider_id,
          is_sender, text, message_type, attachments, timestamp, raw
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (unipile_message_id) DO UPDATE SET
          text = COALESCE(EXCLUDED.text, unipile.message.text),
          raw = unipile.message.raw || EXCLUDED.raw
        """,
        (
            account["id"],
            chat_row["id"],
            message_id,
            provider_id,
            provider_id,
            is_sender,
            payload.get("message"),
            payload.get("event") or "message_received",
            Jsonb(payload.get("attachments") or []),
            payload.get("timestamp"),
            Jsonb(payload),
        ),
    )
    _mark_event(conn, event_id, "processed", {"chat_id": chat_id, "message_id": message_id, "kind": "message"})


def process_one_webhook_event(row: dict[str, Any]) -> None:
    payload = row.get("payload") if isinstance(row.get("payload"), dict) else {}
    event = str(payload.get("event") or row.get("event_type") or "")
    with connect() as conn:
        conn.execute(
            "UPDATE unipile.webhook_event SET processing_status = 'processing' WHERE id = %s",
            (row["id"],),
        )
        try:
            if isinstance(payload.get("AccountStatus"), dict):
                _process_account_status(conn, int(row["id"]), payload)
            elif event == "new_relation":
                _process_new_relation(conn, int(row["id"]), payload)
            elif event.startswith("message_") or event == "message_received":
                _process_message(conn, int(row["id"]), payload)
            else:
                _mark_event(conn, int(row["id"]), "ignored", {"event": event or "unknown"})
            conn.commit()
        except Exception as exc:
            conn.rollback()
            with connect() as err_conn:
                _mark_event(err_conn, int(row["id"]), "failed", {"error": str(exc)[:400]})
                err_conn.commit()


def process_webhook_events(limit: int = 50) -> int:
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT id, source, event_type, payload, received_at
              FROM unipile.webhook_event
             WHERE processing_status IN ('pending','received')
             ORDER BY received_at ASC
             LIMIT %s
            """,
            (limit,),
        ).fetchall()
    for row in rows:
        process_one_webhook_event(dict(row))
    return len(rows)


def worker_heartbeat() -> None:
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO unipile.audit_log (actor, action, entity_type, detail)
            VALUES ('vasari_unipile_worker', 'heartbeat', 'worker', %s)
            """,
            (Jsonb({"service": "linkedin_system"}),),
        )
        conn.commit()


def _claim_actions(limit: int = 3) -> list[dict[str, Any]]:
    if not _inside_work_hours():
        with connect() as conn:
            conn.execute(
                """
                UPDATE unipile.action_queue
                   SET not_before = GREATEST(not_before, %s)
                 WHERE status = 'queued'
                   AND not_before <= now()
                """,
                (_next_work_start(),),
            )
            conn.commit()
        return []
    with connect() as conn:
        rows = conn.execute(
            """
            UPDATE unipile.action_queue q
               SET status = 'running',
                   attempts = attempts + 1,
                   last_error = NULL
             WHERE q.id IN (
               SELECT id
                 FROM unipile.action_queue
                WHERE status = 'queued'
                  AND not_before <= now()
                ORDER BY priority ASC, created_at ASC
                LIMIT %s
             )
             RETURNING q.id, q.account_id, q.action_type, q.payload, q.attempts
            """,
            (limit,),
        ).fetchall()
        conn.commit()
        return [dict(row) for row in rows]


def _mark_action_done(action_id: int, unipile_ref: str | None = None) -> None:
    with connect() as conn:
        conn.execute(
            """
            UPDATE unipile.action_queue
               SET status = 'executed',
                   executed_at = now(),
                   last_error = NULL
             WHERE id = %s
            """,
            (action_id,),
        )
        conn.execute(
            """
            INSERT INTO unipile.audit_log (actor, action, entity_type, entity_id, detail)
            VALUES ('vasari_unipile_worker', 'action_executed', 'action_queue', %s, %s)
            """,
            (str(action_id), Jsonb({"unipile_ref": unipile_ref})),
        )
        conn.commit()


def _mark_action_retry(action: dict[str, Any], error: str) -> None:
    attempts = int(action.get("attempts") or 1)
    status = "failed" if attempts >= 3 else "queued"
    delay = timedelta(minutes=15 * max(1, attempts))
    with connect() as conn:
        conn.execute(
            """
            UPDATE unipile.action_queue
               SET status = %s,
                   not_before = CASE WHEN %s = 'queued' THEN now() + %s::interval ELSE not_before END,
                   last_error = %s
             WHERE id = %s
            """,
            (status, status, delay, error[:800], action["id"]),
        )
        conn.execute(
            """
            INSERT INTO unipile.audit_log (actor, action, entity_type, entity_id, detail)
            VALUES ('vasari_unipile_worker', 'action_' || %s, 'action_queue', %s, %s)
            """,
            (status, str(action["id"]), Jsonb({"error": error[:400], "attempts": attempts})),
        )
        conn.commit()


def _load_action_account(account_id: int) -> dict[str, Any]:
    with connect() as conn:
        row = conn.execute(
            """
            SELECT id, unipile_account_id, provider, status, display_name
              FROM unipile.account
             WHERE id = %s
            """,
            (account_id,),
        ).fetchone()
        if not row:
            raise RuntimeError("account not found")
        return dict(row)


def _budget_available(account_id: int, action_type: str) -> bool:
    cap = _cap_for(action_type)
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO unipile.rate_budget_ledger (account_id, action_type, day, count, cap)
            VALUES (%s, %s, CURRENT_DATE, 0, %s)
            ON CONFLICT (account_id, action_type, day) DO UPDATE SET cap = EXCLUDED.cap
            """,
            (account_id, action_type, cap),
        )
        row = conn.execute(
            """
            SELECT count, cap
              FROM unipile.rate_budget_ledger
             WHERE account_id = %s
               AND action_type = %s
               AND day = CURRENT_DATE
             FOR UPDATE
            """,
            (account_id, action_type),
        ).fetchone()
        available = bool(row and int(row["count"]) < int(row["cap"]))
        if available:
            conn.execute(
                """
                UPDATE unipile.rate_budget_ledger
                   SET count = count + 1,
                       updated_at = now()
                 WHERE account_id = %s
                   AND action_type = %s
                   AND day = CURRENT_DATE
                """,
                (account_id, action_type),
            )
        conn.commit()
        return available


async def _execute_post_accept_message(action: dict[str, Any]) -> str | None:
    account = _load_action_account(int(action["account_id"]))
    if str(account.get("status") or "").upper() in {"ERROR", "STOPPED", "CREDENTIALS"}:
        raise RuntimeError(f"LinkedIn account is not healthy: {account.get('status')}")
    payload = action.get("payload") if isinstance(action.get("payload"), dict) else {}
    text = str(payload.get("text") or "").strip()
    profile_provider_id = str(payload.get("profile_provider_id") or "").strip()
    chat_id = str(payload.get("chat_id") or "").strip()
    if not text:
        raise RuntimeError("queued message has no text")
    if not chat_id and not profile_provider_id:
        raise RuntimeError("queued message has no chat_id or profile_provider_id")
    if not _budget_available(int(account["id"]), "post_accept_message"):
        with connect() as conn:
            conn.execute(
                """
                UPDATE unipile.action_queue
                   SET status = 'queued',
                       not_before = %s,
                       last_error = 'daily message cap reached'
                 WHERE id = %s
                """,
                (_next_work_start() + timedelta(days=1), action["id"]),
            )
            conn.commit()
        return None
    client = UnipileClient()
    if chat_id:
        result = await client.send_chat_message(chat_id, text, account.get("unipile_account_id"))
    else:
        result = await client.start_linkedin_chat(account["unipile_account_id"], profile_provider_id, text)
    return result.get("message_id") or result.get("messageId") or result.get("chat_id")


async def _execute_publish_post(action: dict[str, Any]) -> str | None:
    account = _load_action_account(int(action["account_id"]))
    if str(account.get("status") or "").upper() in {"ERROR", "STOPPED", "CREDENTIALS"}:
        raise RuntimeError(f"LinkedIn account is not healthy: {account.get('status')}")
    payload = action.get("payload") if isinstance(action.get("payload"), dict) else {}
    text = str(payload.get("text") or "").strip()
    external_link = str(payload.get("external_link") or payload.get("link") or "").strip() or None
    media = payload.get("media") if isinstance(payload.get("media"), list) else []
    if external_link and external_link not in text:
        text = f"{text}\n\n{external_link}".strip()
    if not text and not media:
        raise RuntimeError("queued post has no text or media")
    if not _budget_available(int(account["id"]), "publish_post"):
        with connect() as conn:
            conn.execute(
                """
                UPDATE unipile.action_queue
                   SET status = 'queued',
                       not_before = %s,
                       last_error = 'daily post cap reached'
                 WHERE id = %s
                """,
                (_next_work_start() + timedelta(days=1), action["id"]),
            )
            conn.commit()
        return None

    result = await UnipileClient().create_linkedin_post(
        str(account["unipile_account_id"]),
        text,
        external_link=external_link,
        media=[item for item in media if isinstance(item, dict)],
    )
    social_id = str(
        result.get("social_id")
        or result.get("id")
        or result.get("post_id")
        or result.get("object_id")
        or f"published:{action['id']}"
    )
    share_url = result.get("share_url") or result.get("url")
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO unipile.post (
              account_id, social_id, linkedin_id, share_url, is_owned,
              text, posted_at, attachments, raw, last_polled_at
            )
            VALUES (%s, %s, %s, %s, true, %s, now(), %s, %s, now())
            ON CONFLICT (account_id, social_id) DO UPDATE SET
              share_url = COALESCE(EXCLUDED.share_url, unipile.post.share_url),
              is_owned = true,
              text = EXCLUDED.text,
              posted_at = COALESCE(unipile.post.posted_at, EXCLUDED.posted_at),
              attachments = EXCLUDED.attachments,
              raw = unipile.post.raw || EXCLUDED.raw,
              last_polled_at = now()
            """,
            (
                account["id"],
                social_id,
                result.get("id") or result.get("post_id"),
                share_url,
                text,
                Jsonb(media),
                Jsonb({"publish_result": result, "draft_payload": payload}),
            ),
        )
        conn.commit()
    return social_id


async def process_actions(limit: int = 3) -> int:
    actions = _claim_actions(limit)
    for action in actions:
        try:
            if action["action_type"] == "post_accept_message":
                ref = await _execute_post_accept_message(action)
                if ref is not None:
                    _mark_action_done(int(action["id"]), ref)
            elif action["action_type"] == "publish_post":
                ref = await _execute_publish_post(action)
                if ref is not None:
                    _mark_action_done(int(action["id"]), ref)
            else:
                raise RuntimeError(f"unsupported action type: {action['action_type']}")
        except Exception as exc:
            _mark_action_retry(action, str(exc))
    return len(actions)


async def worker_tick() -> dict[str, int]:
    webhook_count = process_webhook_events()
    action_count = await process_actions()
    post_sync = await sync_linkedin_posts_if_due()
    return {
        "webhooks": webhook_count,
        "actions": action_count,
        "post_sync": int(post_sync.get("upserted") or 0) if isinstance(post_sync, dict) else 0,
    }


async def run_worker_loop() -> None:
    worker_heartbeat()
    last_heartbeat = _utcnow()
    while True:
        await worker_tick()
        now = _utcnow()
        if now - last_heartbeat >= timedelta(minutes=5):
            worker_heartbeat()
            last_heartbeat = now
        await asyncio.sleep(10)
