from functools import lru_cache
from typing import Optional

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    database_url: str = Field(default="postgresql://boss:boss@postgres:5432/boss_ir", alias="DATABASE_URL")
    db_schema: str = Field(default="unipile", alias="DB_SCHEMA")

    unipile_dsn: str = Field(default="", alias="UNIPILE_DSN")
    unipile_base_url: str = Field(default="", alias="UNIPILE_BASE_URL")
    unipile_api_url: str = Field(default="", alias="UNIPILE_API_URL")
    unipile_api_key: str = Field(default="", alias="UNIPILE_API_KEY")
    unipile_token: str = Field(default="", alias="UNIPILE_TOKEN")
    unipile_default_account_id: str = Field(default="", alias="UNIPILE_DEFAULT_ACCOUNT_ID")

    public_base_url: str = Field(default="", alias="PUBLIC_BASE_URL")
    webhook_secret: str = Field(default="", alias="WEBHOOK_SECRET")
    timezone: str = Field(default="America/Chicago", alias="TZ")

    cap_invite_no_note_per_day: int = Field(default=15, alias="CAP_INVITE_NO_NOTE_PER_DAY")
    cap_invite_with_note_per_day: int = Field(default=1, alias="CAP_INVITE_WITH_NOTE_PER_DAY")
    cap_message_per_day: int = Field(default=40, alias="CAP_MESSAGE_PER_DAY")
    cap_profile_view_per_day: int = Field(default=80, alias="CAP_PROFILE_VIEW_PER_DAY")
    cap_comment_per_day: int = Field(default=20, alias="CAP_COMMENT_PER_DAY")
    cap_reaction_per_day: int = Field(default=40, alias="CAP_REACTION_PER_DAY")
    cap_follow_per_day: int = Field(default=20, alias="CAP_FOLLOW_PER_DAY")
    cap_publish_post_per_day: int = Field(default=3, alias="CAP_PUBLISH_POST_PER_DAY")
    cap_search_lines_per_day: int = Field(default=800, alias="CAP_SEARCH_LINES_PER_DAY")
    work_hours_start: int = Field(default=8, alias="WORK_HOURS_START")
    work_hours_end: int = Field(default=18, alias="WORK_HOURS_END")
    min_action_gap_seconds: int = Field(default=480, alias="MIN_ACTION_GAP_SECONDS")
    max_action_gap_seconds: int = Field(default=1500, alias="MAX_ACTION_GAP_SECONDS")

    def normalized_base_url(self, runtime_base_url: Optional[str] = None) -> str:
        value = (self.unipile_base_url or self.unipile_api_url or runtime_base_url or self.unipile_dsn).strip()
        if not value:
            return ""
        if not value.startswith(("http://", "https://")):
            value = f"https://{value}"
        return value.rstrip("/")

    def api_key(self, runtime_key: Optional[str] = None) -> str:
        return (self.unipile_api_key or self.unipile_token or runtime_key or "").strip()


@lru_cache
def get_settings() -> Settings:
    return Settings()
