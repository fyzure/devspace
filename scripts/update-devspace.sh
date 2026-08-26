#!/usr/bin/env bash
set -Eeuo pipefail

REPO="${REPO:-fyzure/devspace}"
APP="${APP:-/opt/devspace}"
STATE_DIR="${STATE_DIR:-/var/lib/devspace}"
LEGACY_STATE_DIR="${LEGACY_STATE_DIR:-/root/.local/share/devspace}"
CONFIG_DIR="${CONFIG_DIR:-/etc/devspace}"
LEGACY_CONFIG_DIR="${LEGACY_CONFIG_DIR:-/root/.config/devspace}"
STATE_DB="$STATE_DIR/devspace.sqlite"
SERVICE="${SERVICE:-devspace}"
SERVICE_UNIT="/etc/systemd/system/$SERVICE.service"
SERVICE_DROPIN_DIR="/etc/systemd/system/$SERVICE.service.d"
CLI_BIN="${CLI_BIN:-/usr/local/bin/devspace}"
CARD_STORE_ENV="$CONFIG_DIR/card-store.env"
LEGACY_CARD_STORE_ENV="$LEGACY_CONFIG_DIR/card-store.env"
CARD_STORE_DROPIN="$SERVICE_DROPIN_DIR/card-store.conf"
HEALTH_URL="${HEALTH_URL:-}"

STAGE="$(mktemp -d /var/tmp/devspace-install.XXXXXX)"
BACKUP="$(mktemp -d /var/tmp/devspace-backup.XXXXXX)"

ART="$STAGE/devspace-linux-x64.tar.gz"
SUM="$STAGE/devspace-linux-x64.tar.gz.sha256"
UNPACK="$STAGE/unpacked"
DB_BACKUP="$BACKUP/devspace.sqlite"
APP_BACKUP="$BACKUP/app"
SERVICE_UNIT_BACKUP="$BACKUP/$SERVICE.service"
CARD_STORE_DROPIN_BACKUP="$BACKUP/card-store.conf"
CLI_BIN_BACKUP="$BACKUP/devspace-cli"

BASE="https://github.com/$REPO/releases/latest/download"

DEPLOY_STARTED=0
DB_BACKED_UP=0
APP_EXISTED=0
SERVICE_UNIT_EXISTED=0
STATE_MIGRATED=0
CARD_STORE_ENV_CREATED=0
CARD_STORE_DROPIN_EXISTED=0
CLI_BIN_EXISTED=0

cleanup() {
    rm -rf "$STAGE"
}

rollback() {
    rc=$?
    trap - ERR

    echo
    echo "=== INSTALL FAILED ==="

    if [ "$DEPLOY_STARTED" = "1" ]; then
        echo "=== ROLLING BACK APPLICATION ==="

        systemctl stop "$SERVICE" 2>/dev/null || true

        rm -rf "$APP"
        if [ "$APP_EXISTED" = "1" ] && [ -d "$APP_BACKUP" ]; then
            mv "$APP_BACKUP" "$APP"
        fi

        if [ "$STATE_MIGRATED" = "1" ]; then
            echo "=== ROLLING BACK STATE MIGRATION ==="
            rm -rf "$STATE_DIR"
        elif [ "$DB_BACKED_UP" = "1" ] && [ -f "$DB_BACKUP" ]; then
            echo "=== ROLLING BACK SQLITE STATE ==="
            mkdir -p "$STATE_DIR"
            rm -f "$STATE_DB" "$STATE_DB-wal" "$STATE_DB-shm"
            cp -a "$DB_BACKUP" "$STATE_DB"
            chmod 600 "$STATE_DB"
        fi

        if [ "$SERVICE_UNIT_EXISTED" = "1" ] && [ -f "$SERVICE_UNIT_BACKUP" ]; then
            cp -a "$SERVICE_UNIT_BACKUP" "$SERVICE_UNIT"
        else
            rm -f "$SERVICE_UNIT"
        fi

        if [ "$CARD_STORE_DROPIN_EXISTED" = "1" ] && [ -f "$CARD_STORE_DROPIN_BACKUP" ]; then
            install -d -m 0755 "$SERVICE_DROPIN_DIR"
            cp -a "$CARD_STORE_DROPIN_BACKUP" "$CARD_STORE_DROPIN"
        else
            rm -f "$CARD_STORE_DROPIN"
        fi

        if [ "$CARD_STORE_ENV_CREATED" = "1" ]; then
            rm -f "$CARD_STORE_ENV"
        fi

        rm -f "$CLI_BIN"
        if [ "$CLI_BIN_EXISTED" = "1" ] && { [ -e "$CLI_BIN_BACKUP" ] || [ -L "$CLI_BIN_BACKUP" ]; }; then
            install -d -m 0755 "$(dirname "$CLI_BIN")"
            cp -a "$CLI_BIN_BACKUP" "$CLI_BIN"
        fi

        systemctl daemon-reload 2>/dev/null || true
        systemctl start "$SERVICE" 2>/dev/null || true
    fi

    rm -rf "$STAGE" "$BACKUP"
    exit "$rc"
}

trap rollback ERR
trap cleanup EXIT

echo "=== DevSpace clean reinstall ==="

echo
echo "=== Preflight ==="

command -v curl >/dev/null
command -v tar >/dev/null
command -v sha256sum >/dev/null
command -v node >/dev/null
command -v sqlite3 >/dev/null
command -v systemctl >/dev/null

if [ -d "$APP" ]; then
    APP_EXISTED=1
fi

if [ -f "$SERVICE_UNIT" ]; then
    SERVICE_UNIT_EXISTED=1
    cp -a "$SERVICE_UNIT" "$SERVICE_UNIT_BACKUP"
fi

if [ -f "$CARD_STORE_DROPIN" ]; then
    CARD_STORE_DROPIN_EXISTED=1
    cp -a "$CARD_STORE_DROPIN" "$CARD_STORE_DROPIN_BACKUP"
fi

if [ -e "$CLI_BIN" ] || [ -L "$CLI_BIN" ]; then
    CLI_BIN_EXISTED=1
    cp -a "$CLI_BIN" "$CLI_BIN_BACKUP"
fi

echo "Repository: $REPO"
echo "App:        $APP"
echo "State:      $STATE_DIR"
echo "Config:     $CONFIG_DIR"
echo "CLI:        $CLI_BIN"
echo "Legacy:     $LEGACY_STATE_DIR"
echo "Service:    $SERVICE"

echo
echo "=== Download latest DevSpace release ==="

curl \
    --fail \
    --location \
    --retry 5 \
    --retry-delay 2 \
    --retry-all-errors \
    "$BASE/devspace-linux-x64.tar.gz" \
    -o "$ART"

curl \
    --fail \
    --location \
    --retry 5 \
    --retry-delay 2 \
    --retry-all-errors \
    "$BASE/devspace-linux-x64.tar.gz.sha256" \
    -o "$SUM"

echo
echo "=== Verify SHA-256 ==="

cd "$STAGE"
sha256sum -c "$(basename "$SUM")"

echo
echo "=== Unpack release ==="

mkdir -p "$UNPACK"
tar -xzf "$ART" -C "$UNPACK"

echo
echo "=== Validate release structure ==="

test -f "$UNPACK/package.json"
test -f "$UNPACK/package-lock.json"
test -f "$UNPACK/dist/cli.js"
test -f "$UNPACK/dist/local-agent-daemon-main.js"
test -f "$UNPACK/dist/server.js"
test -d "$UNPACK/dist/ui"
test -d "$UNPACK/node_modules"
test -d "$UNPACK/docs"
test -d "$UNPACK/skills"

VERSION="$(node -e "console.log(require('$UNPACK/package.json').version)")"
echo "Latest release: v$VERSION"

echo
echo "=== Verify native runtime dependencies ==="

(
    cd "$UNPACK"

    node --input-type=module <<'NODE'
const pty = await import("node-pty");
if (typeof pty.spawn !== "function") {
    throw new Error("node-pty runtime verification failed");
}
console.log("node-pty: OK");
NODE

    node --input-type=module <<'NODE'
const { default: Database } = await import("better-sqlite3");
const db = new Database(":memory:");
db.exec("create table test (id integer)");
db.close();
console.log("better-sqlite3: OK");
NODE
)

echo
echo "=== Release validated before service interruption ==="

DEPLOY_STARTED=1

echo
echo "=== Stop DevSpace ==="

systemctl stop "$SERVICE"

for _ in $(seq 1 30); do
    if ! systemctl is-active --quiet "$SERVICE"; then
        break
    fi
    sleep 1
done

if systemctl is-active --quiet "$SERVICE"; then
    echo "DevSpace failed to stop cleanly."
    exit 1
fi

echo
echo "=== Back up persistent SQLite state ==="

SOURCE_STATE_DIR="$STATE_DIR"
SOURCE_STATE_DB="$STATE_DB"

if [ ! -f "$SOURCE_STATE_DB" ] \
    && [ "$STATE_DIR" != "$LEGACY_STATE_DIR" ] \
    && [ -f "$LEGACY_STATE_DIR/devspace.sqlite" ]; then
    SOURCE_STATE_DIR="$LEGACY_STATE_DIR"
    SOURCE_STATE_DB="$LEGACY_STATE_DIR/devspace.sqlite"
fi

if [ -f "$SOURCE_STATE_DB" ]; then
    sqlite3 "$SOURCE_STATE_DB" 'PRAGMA wal_checkpoint(FULL);'
    sqlite3 "$SOURCE_STATE_DB" ".backup '$DB_BACKUP'"
    sqlite3 "$DB_BACKUP" 'PRAGMA integrity_check;' | grep -qx 'ok'
    DB_BACKED_UP=1
    echo "SQLite backup: OK"
else
    echo "No existing SQLite database."
fi

echo
echo "=== Prepare production state directory ==="

if [ "$SOURCE_STATE_DIR" != "$STATE_DIR" ]; then
    if [ -d "$STATE_DIR" ] && [ -n "$(find "$STATE_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
        echo "Refusing to merge legacy state into non-empty target: $STATE_DIR"
        exit 1
    fi

    rm -rf "$STATE_DIR"
    install -d -m 0700 "$STATE_DIR"
    STATE_MIGRATED=1
    cp -a "$SOURCE_STATE_DIR/." "$STATE_DIR/"
    echo "Migrated state: $SOURCE_STATE_DIR -> $STATE_DIR"
else
    install -d -m 0700 "$STATE_DIR"
fi

chmod 700 "$STATE_DIR"

if [ -f "$STATE_DB" ]; then
    sqlite3 "$STATE_DB" 'PRAGMA integrity_check;' | grep -qx 'ok'
fi

echo
echo "=== Prepare production config directory ==="

install -d -m 0755 "$CONFIG_DIR"

if [ ! -f "$CARD_STORE_ENV" ] && [ -f "$LEGACY_CARD_STORE_ENV" ]; then
    install -m 0600 "$LEGACY_CARD_STORE_ENV" "$CARD_STORE_ENV"
    CARD_STORE_ENV_CREATED=1
    echo "Migrated card-store config: $LEGACY_CARD_STORE_ENV -> $CARD_STORE_ENV"
fi

if [ -f "$CARD_STORE_ENV" ]; then
    install -d -m 0755 "$SERVICE_DROPIN_DIR"
    cat > "$CARD_STORE_DROPIN" <<EOF
[Service]
EnvironmentFile=$CARD_STORE_ENV
EOF
    chmod 644 "$CARD_STORE_DROPIN"
fi

echo
echo "=== Remove obsolete deployment cache ==="

rm -rf "$STATE_DIR/deployments"

echo
echo "=== Back up current runtime ==="

mkdir -p "$(dirname "$APP")"
if [ "$APP_EXISTED" = "1" ]; then
    mv "$APP" "$APP_BACKUP"
fi

echo
echo "=== Install fresh runtime ==="

mv "$UNPACK" "$APP"

echo
echo "=== Fix ownership ==="

chown -R root:root "$APP"

echo
echo "=== Install systemd service ==="

cat > "$SERVICE_UNIT" <<EOF
[Unit]
Description=DevSpace MCP Server
Documentation=https://github.com/$REPO
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=$APP
Environment=HOME=/root
Environment=NODE_ENV=production
Environment=DEVSPACE_STATE_DIR=$STATE_DIR
Environment=DEVSPACE_TOOL_MODE=full
Environment=DEVSPACE_WIDGETS=changes
Environment=DEVSPACE_ARTIFACTS=1
ExecStart=/usr/bin/node $APP/dist/cli.js serve
Restart=on-failure
RestartSec=5s
TimeoutStopSec=30s
KillSignal=SIGTERM
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

chmod 644 "$SERVICE_UNIT"

echo
echo "=== Install CLI entry point ==="

install -d -m 0755 "$(dirname "$CLI_BIN")"
cat > "$CLI_BIN" <<EOF
#!/bin/sh
exec /usr/bin/node "$APP/dist/cli.js" "\$@"
EOF
chmod 755 "$CLI_BIN"

echo
echo "=== Verify installed package ==="

INSTALLED_VERSION="$(node -e "console.log(require('$APP/package.json').version)")"

if [ "$INSTALLED_VERSION" != "$VERSION" ]; then
    echo "Version mismatch:"
    echo "  expected:  $VERSION"
    echo "  installed: $INSTALLED_VERSION"
    exit 1
fi

CLI_VERSION="$("$CLI_BIN" --version)"
if [ "$CLI_VERSION" != "$VERSION" ]; then
    echo "CLI version mismatch:"
    echo "  expected:  $VERSION"
    echo "  installed: $CLI_VERSION"
    exit 1
fi

(
    cd "$APP"
    node --input-type=module -e \
        "const pty = await import('node-pty'); if (typeof pty.spawn !== 'function') process.exit(1)"
    node --input-type=module -e \
        "const { default: Database } = await import('better-sqlite3'); const db = new Database(':memory:'); db.close()"
)

echo
echo "=== Start DevSpace ==="

systemctl daemon-reload
systemctl start "$SERVICE"

echo
echo "=== Wait for service ==="

SERVICE_OK=0
for _ in $(seq 1 30); do
    if systemctl is-active --quiet "$SERVICE"; then
        SERVICE_OK=1
        break
    fi
    sleep 1
done

if [ "$SERVICE_OK" != "1" ]; then
    echo "DevSpace failed to start."
    journalctl -u "$SERVICE" -n 100 --no-pager || true
    exit 1
fi

MAIN_PID="$(systemctl show "$SERVICE" --property=MainPID --value)"
test -n "$MAIN_PID"
test "$MAIN_PID" != "0"
kill -0 "$MAIN_PID"

echo
echo "=== Verify SQLite after migration ==="

if [ -f "$STATE_DB" ]; then
    sqlite3 "$STATE_DB" 'PRAGMA integrity_check;' | grep -qx 'ok'
    echo "SQLite integrity: OK"
fi

if [ -n "$HEALTH_URL" ]; then
    echo
    echo "=== HTTP health check ==="

    HEALTH_OK=0
    for _ in $(seq 1 30); do
        if curl --fail --silent --show-error --max-time 5 "$HEALTH_URL" >/dev/null; then
            HEALTH_OK=1
            break
        fi
        sleep 1
    done

    if [ "$HEALTH_OK" != "1" ]; then
        echo "Health check failed: $HEALTH_URL"
        journalctl -u "$SERVICE" -n 100 --no-pager || true
        exit 1
    fi

    echo "Health check: OK"
fi

RUNNING_VERSION="$(node -e "console.log(require('$APP/package.json').version)")"

echo
echo "=== Installation successful ==="
echo "Version: v$RUNNING_VERSION"
echo "Service: $(systemctl is-active "$SERVICE")"
echo "PID:     $MAIN_PID"

DEPLOY_STARTED=0

rm -rf "$BACKUP"
trap - ERR
trap - EXIT
rm -rf "$STAGE"

echo "=== DONE ==="
