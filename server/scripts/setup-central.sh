#!/usr/bin/env bash
# setup-central.sh — поднимает central-узел сети RestOS ОДНИМ прогоном
# (ADR-003, продолжение): бинарь → бутстрап → сеть → код приглашения.
# На выходе — готовая pairing-ссылка, которую сразу можно вставлять на
# кассе филиала (Настройки → Синхронизация → «Код приглашения»).
#
# Использование (на VPS, обычно под root — для systemd-автозапуска):
#   ./setup-central.sh <публичный-адрес> [название-сети] [PIN-владельца]
#   ./setup-central.sh https://central.example.com "Моя сеть" 1234
#
# Локальный прогон против уже запущенного сервера (без systemd) —
# достаточно передать API_BASE:
#   API_BASE=http://127.0.0.1:3002 ./setup-central.sh http://127.0.0.1:3002
#
# Бинарь собирается заранее: cd server && make build-all
#   → bin/restos-server-linux-amd64 (залить на VPS в $BIN_PATH).
#
# Несколько организаций на ОДНОМ VPS: прогнать скрипт повторно с ДРУГИМ
# PORT (обязательно — два процесса не могут слушать один порт). BIN_PATH
# общий (одна версия бинаря на все организации) — это нормально, он
# read-only. Всё остальное (systemd-юнит, data-dir, env-файл с секретом)
# автоматически разводится по $INSTANCE (по умолчанию — "org-$PORT", так
# как PORT и так обязан быть уникальным; можно задать своё осмысленное имя
# явно: INSTANCE=pizza-tashkent PORT=3003 ./setup-central.sh ...).
set -euo pipefail

PUBLIC_URL="${1:?Использование: setup-central.sh <публичный-адрес> [название] [PIN]}"
RESTAURANT_NAME="${2:-Центральный склад}"
OWNER_PIN="${3:-$(( RANDOM % 9000 + 1000 ))}"

BIN_PATH="${BIN_PATH:-/opt/restos/restos-server}"
PORT="${PORT:-3002}"
INSTANCE="${INSTANCE:-org-${PORT}}"
DATA_DIR="${DATA_DIR:-/opt/restos/${INSTANCE}/data}"
# У каждого инстанса — СВОЙ embedded Postgres (child-процесс restos-server),
# у него тоже отдельный порт (по умолчанию 54330), а не только у REST API.
# Если оставить его общим — второй/следующий инстанс на этом же VPS будет
# падать "process already listening on port 54330" (нашли вживую при
# тестировании). Сдвигаем на ту же дельту, что и PORT — при PORT=3002 (дефолт
# одиночной установки) даёт ровно 54330, как раньше, без изменения поведения.
PG_PORT="${PG_PORT:-$((54330 + PORT - 3002))}"
API_BASE="${API_BASE:-http://127.0.0.1:${PORT}}"
API="${API_BASE}/api/v1"

log() { echo "[setup-central] $*" >&2; }

# POST/PUT/DELETE в /api/v1 требуют Idempotency-Key (UUID, см. CLAUDE.md) —
# без него мидлварь отвечает 400 ещё до хендлера.
gen_uuid() {
  if command -v uuidgen > /dev/null 2>&1; then
    uuidgen | tr '[:upper:]' '[:lower:]'
  elif [ -r /proc/sys/kernel/random/uuid ]; then
    cat /proc/sys/kernel/random/uuid
  else
    printf '%04x%04x-%04x-4%03x-%04x-%04x%04x%04x\n' \
      $((RANDOM)) $((RANDOM)) $((RANDOM)) $((RANDOM % 4096)) \
      $((RANDOM % 16384 + 32768)) $((RANDOM)) $((RANDOM)) $((RANDOM))
  fi
}

# ─── Шаг 1: сервер уже поднят? Если нет — поднимаем ────────────────────────
if ! curl -sf "$API/bootstrap/status" > /dev/null 2>&1; then
  if [ ! -x "$BIN_PATH" ]; then
    echo "Бинарь не найден: $BIN_PATH" >&2
    echo "Соберите локально (cd server && make build-all) и залейте на сервер," >&2
    echo "либо укажите API_BASE=http://хост:порт уже запущенного сервера." >&2
    exit 1
  fi

  SYNC_TOKEN="$(openssl rand -hex 16)"
  mkdir -p "$DATA_DIR"

  if command -v systemctl > /dev/null && [ "$(id -u)" = "0" ]; then
    SERVICE_NAME="restos-central-${INSTANCE}"
    log "root + systemd — ставлю автозапуск (${SERVICE_NAME}.service)"

    # Уже есть ДРУГОЙ инстанс на этом же порту (юнит есть, но имя другое) —
    # значит INSTANCE/PORT не согласованы с реальным состоянием VPS. Лучше
    # остановиться и разобраться, чем молча породить два юнита на один порт.
    for u in /etc/systemd/system/restos-central-*.service; do
      [ -e "$u" ] || continue
      if [ "$u" != "/etc/systemd/system/${SERVICE_NAME}.service" ] && \
         grep -q "RESTOS_HTTP_ADDR=0.0.0.0:${PORT}$" \
           "/etc/restos-central-$(basename "$u" .service | sed 's/^restos-central-//').env" 2>/dev/null; then
        echo "Порт ${PORT} уже занят другим юнитом: $(basename "$u")." >&2
        echo "Укажите свободный PORT для «${RESTAURANT_NAME}»." >&2
        exit 1
      fi
    done

    # Отдельный системный пользователь ОБЩИЙ для всех организаций на VPS
    # (не по одному на организацию — БД и файлы всё равно разведены через
    # DATA_DIR/$INSTANCE, отдельный unix-юзер на каждую орг только усложнил
    # бы без выигрыша в изоляции). embedded Postgres — обычный дистрибутив
    # PG, а initdb/postgres жёстко отказываются работать под root («root
    # execution ... not permitted») — юнит под root уходил бы в crash-loop.
    # HOME нужен валидный: библиотека embedded-postgres качает архив
    # дистрибутива в ~/.embedded-postgres-go при первом старте.
    SERVICE_USER="restos"
    if ! id -u "$SERVICE_USER" > /dev/null 2>&1; then
      useradd --system --home-dir /opt/restos --shell /usr/sbin/nologin "$SERVICE_USER"
    fi
    chown -R "$SERVICE_USER:" "$DATA_DIR"

    # Секрет — НЕ в юните (юниты world-readable, 644), а в env-файле 0600.
    # Имя файла с $INSTANCE — иначе второй прогон на этом же VPS для другой
    # организации перезаписал бы секрет и адрес первой.
    ENV_FILE="/etc/restos-central-${INSTANCE}.env"
    cat > "$ENV_FILE" <<EOF
RESTOS_SYNC_TOKEN=${SYNC_TOKEN}
RESTOS_HTTP_ADDR=0.0.0.0:${PORT}
RESTOS_DATA_DIR=${DATA_DIR}
RESTOS_PG_PORT=${PG_PORT}
HOME=${DATA_DIR}
EOF
    chmod 600 "$ENV_FILE"

    cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=RestOS central node — ${INSTANCE} (ADR-003)
After=network.target

[Service]
User=${SERVICE_USER}
EnvironmentFile=${ENV_FILE}
ExecStart=${BIN_PATH}
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable --now "$SERVICE_NAME"
  else
    if [ "$(id -u)" = "0" ]; then
      echo "Запуск под root без systemd не поддерживается: embedded Postgres" >&2
      echo "отказывается работать под root. Запустите скрипт обычным пользователем" >&2
      echo "или на systemd-хосте (юнит сам заведёт системного пользователя restos)." >&2
      exit 1
    fi
    log "нет systemd — просто запускаю бинарь в фоне (nohup)"
    log "для автозапуска после перезагрузки — прогнать под root на systemd-хосте"
    RESTOS_SYNC_TOKEN="$SYNC_TOKEN" RESTOS_HTTP_ADDR="0.0.0.0:${PORT}" RESTOS_DATA_DIR="$DATA_DIR" \
      RESTOS_PG_PORT="$PG_PORT" \
      nohup "$BIN_PATH" > "${DATA_DIR}/restos-central.log" 2>&1 &
    disown
  fi

  log "жду запуска сервера на $API..."
  until curl -sf "$API/bootstrap/status" > /dev/null 2>&1; do sleep 1; done
fi

# ─── Шаг 2: бутстрап (пропускаем, если уже инициализирован) ────────────────
STATUS="$(curl -sf "$API/bootstrap/status")"
if echo "$STATUS" | grep -q '"initialized":true'; then
  EXISTING_NAMES="$(echo "$STATUS" | grep -o '"name":"[^"]*"' | cut -d'"' -f4)"
  # На этом PORT уже отвечает КАКОЙ-ТО сервер, но не факт что это наша
  # организация — если название не совпадает ни с одним существующим,
  # это, скорее всего, чужой инстанс (PORT перепутан/не задан при повторном
  # прогоне для другой организации на этом же VPS). Молча продолжать нельзя:
  # ниже "уже инициализирован, ничего не создаю" был бы враньём про ЧУЖУЮ
  # организацию, а владелец «${RESTAURANT_NAME}» решил бы, что уже готово.
  if ! echo "$EXISTING_NAMES" | grep -qxF "$RESTAURANT_NAME"; then
    echo "На порту ${PORT} уже отвечает ДРУГАЯ организация: ${EXISTING_NAMES}" >&2
    echo "Это не «${RESTAURANT_NAME}». Укажите свободный PORT, например:" >&2
    echo "  PORT=3003 INSTANCE=my-org ./setup-central.sh ..." >&2
    exit 1
  fi
  log "сервер уже инициализирован — бутстрап/сеть/код НЕ создаю повторно."
  log "текущие рестораны: $(echo "$STATUS" | grep -o '"name":"[^"]*"' | tr '\n' ' ')"
  log "если нужен ещё один код приглашения — сгенерируйте его в UI"
  log "(Настройки → Филиалы сети → Приглашения) или обратитесь к API напрямую."
  exit 0
fi

log "бутстрап ресторана «$RESTAURANT_NAME»..."
BOOT="$(curl -sf -X POST "$API/bootstrap" -H 'Content-Type: application/json' \
  -d "{\"restaurant_name\":\"${RESTAURANT_NAME}\",\"owner_name\":\"Владелец\",\"owner_pin\":\"${OWNER_PIN}\"}")"
RID="$(echo "$BOOT" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)"
if [ -z "$RID" ]; then
  echo "Бутстрап не вернул id ресторана: $BOOT" >&2
  exit 1
fi
log "ресторан заведён: $RID"

# ─── Шаг 3: логин (PIN → Bearer-токен) ──────────────────────────────────────
TOKEN="$(curl -sf -X POST "$API/auth/login" -H 'Content-Type: application/json' \
  -d "{\"restaurant_id\":\"${RID}\",\"pin\":\"${OWNER_PIN}\"}" \
  | grep -o '"token":"[^"]*"' | cut -d'"' -f4)"
if [ -z "$TOKEN" ]; then
  echo "Логин не вернул токен — проверьте PIN." >&2
  exit 1
fi

# ─── Шаг 4: сеть + код приглашения ──────────────────────────────────────────
curl -sf -X POST "$API/network" -H "Authorization: Bearer ${TOKEN}" -H "Idempotency-Key: $(gen_uuid)" \
  -H 'Content-Type: application/json' -d "{\"name\":\"${RESTAURANT_NAME}\"}" > /dev/null
log "сеть создана — этот ресторан теперь центральный склад"

PAIRING_URL="$(curl -sf -X POST "$API/network/invites" -H "Authorization: Bearer ${TOKEN}" -H "Idempotency-Key: $(gen_uuid)" \
  -H 'Content-Type: application/json' -d "{\"label\":\"Первый филиал\",\"public_url\":\"${PUBLIC_URL}\"}" \
  | grep -o '"pairing_url":"[^"]*"' | cut -d'"' -f4)"
if [ -z "$PAIRING_URL" ]; then
  echo "Не удалось сгенерировать код приглашения." >&2
  exit 1
fi

echo ""
echo "════════════════════════════════════════════════════════"
echo " Central готов: ${PUBLIC_URL}"
echo " PIN владельца: ${OWNER_PIN} (сохраните!)"
echo ""
echo " Код для первого филиала — вставить на кассе в"
echo " Настройки → Синхронизация → «Код приглашения»:"
echo ""
echo " ${PAIRING_URL}"
echo "════════════════════════════════════════════════════════"
