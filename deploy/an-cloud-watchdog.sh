#!/usr/bin/env bash
# ==============================================================================
# AN Cloud — Automated Watchdog & Self-Healing Service for Raspberry Pi 4
# ==============================================================================
set -u

LOG_FILE="/var/log/an-cloud-watchdog.log"
HEALTH_URL="http://127.0.0.1:3000/api/v1/health"
MOUNT_POINT="/mnt/cloud"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | sudo tee -a "${LOG_FILE}" >/dev/null
}

# 1. Check if the physical HDD is mounted
if ! mountpoint -q "${MOUNT_POINT}"; then
  log "WARNING: ${MOUNT_POINT} is not mounted! Attempting auto-mount..."
  sudo mount -a 2>&1 | while read -r line; do log "mount -a: $line"; done
  sleep 3
fi

# Re-check mount
if ! mountpoint -q "${MOUNT_POINT}"; then
  log "CRITICAL: Could not mount ${MOUNT_POINT}. HDD may be disconnected or unformatted."
  exit 1
fi

# 2. Check if Nginx is active
if ! systemctl is-active --quiet nginx; then
  log "Nginx is stopped. Restarting Nginx..."
  sudo systemctl restart nginx
fi

# 3. Check AN Cloud Backend Health Endpoint
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 --max-time 10 "${HEALTH_URL}" || echo "000")

if [ "${HTTP_STATUS}" != "200" ]; then
  log "WARNING: Backend health check failed (HTTP ${HTTP_STATUS}). Restarting scorpiocloud.service..."
  sudo systemctl restart scorpiocloud
  sleep 6
  
  # Verify recovery
  RETRY_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 --max-time 10 "${HEALTH_URL}" || echo "000")
  if [ "${RETRY_STATUS}" == "200" ]; then
    log "SUCCESS: scorpiocloud self-healed and is back online (HTTP 200)."
  else
    log "ERROR: scorpiocloud restart attempted but backend returned HTTP ${RETRY_STATUS}."
  fi
fi
