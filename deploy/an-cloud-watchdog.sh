#!/usr/bin/env bash
# ==============================================================================
# AN Cloud — Multi-Tier Automated Fallback & Self-Healing Watchdog
# Runs silently every 2 minutes via systemd timer
# ==============================================================================
set -u

LOG_FILE="/var/log/an-cloud-watchdog.log"
HEALTH_URL="http://127.0.0.1:3000/api/v1/health"
MOUNT_POINT="/mnt/cloud"
APP_USER="anvithgopa"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | sudo tee -a "${LOG_FILE}" >/dev/null
}

# ------------------------------------------------------------------------------
# TIER 1: HDD Mount & Storage Recovery
# ------------------------------------------------------------------------------
if ! mountpoint -q "${MOUNT_POINT}"; then
  log "[TIER 1] WARNING: ${MOUNT_POINT} is not mounted! Running mount -a..."
  sudo mount -a 2>&1 | while read -r line; do log "mount -a: $line"; done
  sleep 2
fi

# Fallback auto-detection if /etc/fstab missed it (e.g. USB/SATA slow spin-up)
if ! mountpoint -q "${MOUNT_POINT}"; then
  log "[TIER 1] WARNING: mount -a failed. Searching for ANCloud drive by label/partition..."
  if [ -b "/dev/disk/by-label/ANCloud" ]; then
    sudo mount /dev/disk/by-label/ANCloud "${MOUNT_POINT}"
    log "[TIER 1] Mounted /dev/disk/by-label/ANCloud to ${MOUNT_POINT}."
  elif [ -b "/dev/sda1" ]; then
    sudo mount /dev/sda1 "${MOUNT_POINT}"
    log "[TIER 1] Fallback mounted /dev/sda1 to ${MOUNT_POINT}."
  fi
fi

if ! mountpoint -q "${MOUNT_POINT}"; then
  log "[TIER 1] CRITICAL: External HDD not found. Check physical USB/SATA connection."
  exit 1
fi

# Ensure critical identity and temp folders exist and are writable
if [ ! -f "${MOUNT_POINT}/config/.hdd-identity" ]; then
  mkdir -p "${MOUNT_POINT}/config"
  echo "WD-SCORPIO-BLUE-250GB" | sudo tee "${MOUNT_POINT}/config/.hdd-identity" >/dev/null
  sudo chown "${APP_USER}:${APP_USER}" "${MOUNT_POINT}/config/.hdd-identity"
fi

if [ ! -d "${MOUNT_POINT}/data/temp" ]; then
  mkdir -p "${MOUNT_POINT}/data/temp"
  sudo chown -R "${APP_USER}:${APP_USER}" "${MOUNT_POINT}/data/temp"
  sudo chmod 775 "${MOUNT_POINT}/data/temp"
fi

# ------------------------------------------------------------------------------
# TIER 2: Network & Reverse Proxy Health (Tailscale & Nginx)
# ------------------------------------------------------------------------------
if command -v systemctl >/dev/null 2>&1; then
  # Auto-recover Tailscale
  if systemctl is-enabled --quiet tailscaled 2>/dev/null && ! systemctl is-active --quiet tailscaled; then
    log "[TIER 2] Tailscale daemon down. Restarting tailscaled..."
    sudo systemctl restart tailscaled
  fi

  # Auto-recover Nginx
  if ! systemctl is-active --quiet nginx; then
    log "[TIER 2] Nginx is down. Restarting nginx..."
    sudo systemctl restart nginx
  fi
fi

# ------------------------------------------------------------------------------
# TIER 3: Backend Node.js Service Health & Escalation
# ------------------------------------------------------------------------------
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 4 --max-time 8 "${HEALTH_URL}" || echo "000")

if [ "${HTTP_STATUS}" != "200" ]; then
  log "[TIER 3] WARNING: Health check failed (HTTP ${HTTP_STATUS}). Initiating restart..."
  sudo systemctl restart scorpiocloud
  sleep 5

  # Verify if restarted successfully
  HTTP_STATUS_RETRY=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 4 --max-time 8 "${HEALTH_URL}" || echo "000")
  
  # Escalation: If standard restart failed, clear stale ports & force-kill zombie processes
  if [ "${HTTP_STATUS_RETRY}" != "200" ]; then
    log "[TIER 3] ESCALATION: Backend still unresponsive (HTTP ${HTTP_STATUS_RETRY}). Killing any lingering port 3000 processes..."
    sudo fuser -k 3000/tcp 2>/dev/null || true
    sleep 2
    sudo systemctl restart scorpiocloud
    sleep 5
    FINAL_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 4 --max-time 8 "${HEALTH_URL}" || echo "000")
    if [ "${FINAL_STATUS}" == "200" ]; then
      log "[TIER 3] SUCCESS: Force restart cleared port and backend is now HEALTHY (HTTP 200)."
    else
      log "[TIER 3] CRITICAL: Self-healing attempted but backend returned HTTP ${FINAL_STATUS}. Check journalctl -u scorpiocloud."
    fi
  else
    log "[TIER 3] SUCCESS: Service recovered cleanly (HTTP 200)."
  fi
fi
