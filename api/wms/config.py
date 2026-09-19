from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="WMS_", extra="ignore")

    database_url: str = "postgresql+psycopg://wms:wms@127.0.0.1:5432/wms"
    secret_key: str = "change-me"
    message_ttl_hours: int = 24
    worker_poll_seconds: float = 5.0
    worker_http_timeout_seconds: float = 10.0


@lru_cache
def get_settings() -> Settings:
    return Settings()
