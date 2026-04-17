#!/bin/sh
set -eu

: "${PORT:=7350}"
: "${CONSOLE_PORT:=$((PORT + 1))}"
: "${NAKAMA_SERVER_KEY:=defaultkey}"
: "${SESSION_ENCRYPTION_KEY:=defaultencryptionkey}"
: "${SESSION_REFRESH_ENCRYPTION_KEY:=defaultrefreshencryptionkey}"
: "${RUNTIME_HTTP_KEY:=defaulthttpkey}"
: "${NAKAMA_ADMIN_USER:=admin}"
: "${NAKAMA_ADMIN_PASSWORD:=admin}"

if [ -z "${DATABASE_ADDRESS:-}" ]; then
  raw_database_url="${DATABASE_URL:-${DATABASE_CONNECTION_STRING:-}}"
  if [ -n "$raw_database_url" ]; then
    DATABASE_ADDRESS="${raw_database_url#postgresql://}"
    DATABASE_ADDRESS="${DATABASE_ADDRESS#postgres://}"
  else
    DATABASE_ADDRESS="root@cockroachdb:26257"
  fi
fi

/nakama/nakama migrate up --database.address "$DATABASE_ADDRESS"

exec /nakama/nakama \
  --name lila-tictactoe \
  --database.address "$DATABASE_ADDRESS" \
  --socket.port "$PORT" \
  --socket.server_key "$NAKAMA_SERVER_KEY" \
  --session.encryption_key "$SESSION_ENCRYPTION_KEY" \
  --session.refresh_encryption_key "$SESSION_REFRESH_ENCRYPTION_KEY" \
  --runtime.http_key "$RUNTIME_HTTP_KEY" \
  --console.port "$CONSOLE_PORT" \
  --console.username "$NAKAMA_ADMIN_USER" \
  --console.password "$NAKAMA_ADMIN_PASSWORD" \
  --logger.level INFO
