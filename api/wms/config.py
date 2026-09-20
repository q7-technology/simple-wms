from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="WMS_", extra="ignore")

    database_url: str = "postgresql+psycopg://wms:wms@127.0.0.1:5432/wms"
    secret_key: str = "change-me"
    message_ttl_hours: int = 24
    worker_poll_seconds: float = 5.0
    worker_http_timeout_seconds: float = 10.0

    # Single sign-on. Leave the issuer empty and the sign-in screen offers
    # only a password, which is what a small install wants.
    oidc_issuer: str = ""
    oidc_client_id: str = ""
    oidc_client_secret: str = ""
    oidc_redirect_uri: str = ""
    oidc_scopes: str = ""
    oidc_name: str = ""
    # Whether somebody the provider knows but the WMS does not gets an account.
    # Off by default: supervisors create accounts, IT audits them.
    oidc_create_users: bool = False
    oidc_default_role: str = "picker"


@lru_cache
def get_settings() -> Settings:
    return Settings()
