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
set -euo pipefail

PUBLIC_URL="${1:?Использование: setup-central.sh <публичный-адрес> [название] [PIN]}"
RESTAURANT_NAME="${2:-Центральный склад}"
OWNER_PIN="${3:-$(( RANDOM % 9000 + 1000 ))}"

BIN_PATH="${BIN_PATH:-/opt/restos/restos-server}"
DATA_DIR="${DATA_DIR:-/opt/restos/data}"
PORT="${PORT:-3002}"
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
    log "root + systemd — ставлю автозапуск (restos-central.service)"
    cat > /etc/systemd/system/restos-central.service <<EOF
[Unit]
Description=RestOS central node (ADR-003)
After=network.target

[Service]
Environment=RESTOS_SYNC_TOKEN=${SYNC_TOKEN}
Environment=RESTOS_HTTP_ADDR=0.0.0.0:${PORT}
Environment=RESTOS_DATA_DIR=${DATA_DIR}
ExecStart=${BIN_PATH}
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable --now restos-central
  else
    log "нет root/systemd — просто запускаю бинарь в фоне (nohup)"
    log "для автозапуска после перезагрузки — прогнать под root на systemd-хосте"
    RESTOS_SYNC_TOKEN="$SYNC_TOKEN" RESTOS_HTTP_ADDR="0.0.0.0:${PORT}" RESTOS_DATA_DIR="$DATA_DIR" \
      nohup "$BIN_PATH" > "${DATA_DIR}/restos-central.log" 2>&1 &
    disown
  fi

  log "жду запуска сервера на $API..."
  until curl -sf "$API/bootstrap/status" > /dev/null 2>&1; do sleep 1; done
fi

# ─── Шаг 2: бутстрап (пропускаем, если уже инициализирован) ────────────────
STATUS="$(curl -sf "$API/bootstrap/status")"
if echo "$STATUS" | grep -q '"initialized":true'; then
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
