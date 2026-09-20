#!/bin/sh
# One nightly dump of the database, kept for a while, verified on the way out.
#
# Run by the `backup` compose profile, or by cron on the host:
#   0 2 * * *  cd /srv/simple-wms && docker compose run --rm backup
#
# The ledger is append-only, so a dump is a true picture of every movement
# that ever happened. Keep one off the machine as well: a VM snapshot is not
# a database backup, and neither is a copy on the same disk.
set -eu

DIR="${BACKUP_DIR:-/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
FILE="$DIR/${POSTGRES_DB:-wms}-$STAMP.sql.gz"

mkdir -p "$DIR"

echo "backing up ${POSTGRES_DB:-wms} to $FILE"
pg_dump --host "${POSTGRES_HOST:-db}" --username "${POSTGRES_USER:-wms}" \
        --dbname "${POSTGRES_DB:-wms}" --no-owner --no-privileges --clean --if-exists \
    | gzip -9 > "$FILE.part"

# a dump that will not unzip is not a backup
gzip -t "$FILE.part"
mv "$FILE.part" "$FILE"
SIZE="$(du -h "$FILE" | cut -f1)"
echo "wrote $FILE ($SIZE)"

# keep the newest, drop anything past the window
find "$DIR" -name "*.sql.gz" -type f -mtime "+$KEEP_DAYS" -print -delete

COUNT="$(find "$DIR" -name '*.sql.gz' -type f | wc -l | tr -d ' ')"
echo "$COUNT backups in $DIR, keeping $KEEP_DAYS days"
