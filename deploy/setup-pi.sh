#!/usr/bin/env bash
# ==============================================================================
# ScorpioCloud — Raspberry Pi 4 Automated Setup & Deployment Script
# Target OS: Raspberry Pi OS Lite (64-bit / ARM64)
# Target Storage: WD Scorpio Blue 250GB SATA HDD mounted at /mnt/cloud
# NOTE: This script NEVER formats or repartitions your HDD.
# ==============================================================================
set -euo pipefail

MOUNT_POINT="/mnt/cloud"
APP_USER="cloudadmin"

echo "=== ScorpioCloud Raspberry Pi 4 Provisioning ==="

if ! mountpoint -q "${MOUNT_POINT}"; then
  echo "ERROR: ${MOUNT_POINT} is not mounted."
  echo "Please mount your WD Scorpio Blue 250GB HDD to ${MOUNT_POINT} via /etc/fstab using its UUID first."
  echo "Run 'lsblk -f' or 'sudo blkid' to inspect your HDD UUID."
  exit 1
fi

# 1. Create dedicated service user if not exists
if ! id -u "${APP_USER}" >/dev/null 2>&1; then
  sudo useradd --system --user-group --home-dir "${MOUNT_POINT}/app" --shell /usr/sbin/nologin "${APP_USER}"
  echo "Created system user: ${APP_USER}"
fi

# 2. Create required directory structure on the physical HDD
sudo mkdir -p \
  "${MOUNT_POINT}/app" \
  "${MOUNT_POINT}/config" \
  "${MOUNT_POINT}/data/files" \
  "${MOUNT_POINT}/data/database" \
  "${MOUNT_POINT}/data/index" \
  "${MOUNT_POINT}/data/jobs" \
  "${MOUNT_POINT}/data/logs" \
  "${MOUNT_POINT}/data/temp" \
  "${MOUNT_POINT}/data/temp/trash" \
  "${MOUNT_POINT}/data/temp/nginx_body" \
  "${MOUNT_POINT}/data/backups"

# 3. Initialize HDD identity marker if not present
if [ ! -f "${MOUNT_POINT}/config/.hdd-identity" ]; then
  echo "WD-SCORPIO-BLUE-250GB" | sudo tee "${MOUNT_POINT}/config/.hdd-identity" >/dev/null
  echo "Initialized ${MOUNT_POINT}/config/.hdd-identity"
fi

# 4. Generate production .env with high-entropy secret if not present
if [ ! -f "${MOUNT_POINT}/config/.env" ]; then
  SECRET=$(openssl rand -hex 32)
  cat <<EOF | sudo tee "${MOUNT_POINT}/config/.env" >/dev/null
PORT=3000
HOST=127.0.0.1
NODE_ENV=production
STORAGE_ROOT=/mnt/cloud
REQUIRE_MOUNT_CHECK=true
HDD_IDENTITY_TOKEN=WD-SCORPIO-BLUE-250GB
SESSION_SECRET=${SECRET}
SECURE_COOKIES=false
MAX_UPLOAD_FILE_SIZE_BYTES=10737418240
DEFAULT_GUEST_QUOTA_BYTES=5368709120
MAX_CONCURRENT_GUEST_UPLOADS=3
INDEXER_INTERVAL_MINUTES=30
EOF
  sudo chmod 600 "${MOUNT_POINT}/config/.env"
  echo "Generated ${MOUNT_POINT}/config/.env"
fi

# 5. Set ownership and permissions
sudo chown -R "${APP_USER}:${APP_USER}" "${MOUNT_POINT}"
sudo chmod +x "${MOUNT_POINT}/app/deploy/verify-hdd-mount.sh" || true

# Allow Nginx (www-data) to write temporary request bodies to /mnt/cloud/data/temp/nginx_body
if id -u www-data >/dev/null 2>&1; then
  sudo chown -R www-data:www-data "${MOUNT_POINT}/data/temp/nginx_body"
fi

# 6. Install systemd service and Nginx config
if [ -f "${MOUNT_POINT}/app/deploy/scorpiocloud.service" ]; then
  sudo cp "${MOUNT_POINT}/app/deploy/scorpiocloud.service" /etc/systemd/system/scorpiocloud.service
  sudo systemctl daemon-reload
  sudo systemctl enable scorpiocloud.service
fi

if [ -f "${MOUNT_POINT}/app/deploy/nginx-scorpiocloud.conf" ] && [ -d /etc/nginx/sites-available ]; then
  sudo cp "${MOUNT_POINT}/app/deploy/nginx-scorpiocloud.conf" /etc/nginx/sites-available/scorpiocloud
  sudo ln -sf /etc/nginx/sites-available/scorpiocloud /etc/nginx/sites-enabled/scorpiocloud
  sudo rm -f /etc/nginx/sites-enabled/default
  sudo nginx -t && sudo systemctl reload nginx
fi

echo "=== Setup Complete! Start service with: sudo systemctl start scorpiocloud ==="
