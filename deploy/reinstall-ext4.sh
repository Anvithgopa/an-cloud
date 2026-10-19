#!/usr/bin/env bash
# ==============================================================================
# AN Cloud — Complete One-Shot Reinstall & Format Helper for Raspberry Pi 4
# Usage:
#   1. Copy this script to ~ on your Raspberry Pi: cp /mnt/cloud/app/deploy/reinstall-ext4.sh ~/
#   2. Run: bash ~/reinstall-ext4.sh /dev/sda1
# ==============================================================================
set -euo pipefail

DEVICE="${1:-/dev/sda1}"
MOUNT_POINT="/mnt/cloud"
BACKUP_TAR="$HOME/an-cloud-backup.tar.gz"

echo "=== [1/6] Stopping scorpiocloud.service and backing up app code to ${BACKUP_TAR} ==="
sudo systemctl stop scorpiocloud.service 2>/dev/null || true

if [ -d "${MOUNT_POINT}/app" ] && [ -f "${MOUNT_POINT}/app/package.json" ]; then
  tar --exclude='node_modules' --exclude='.local-cloud*' -czf "${BACKUP_TAR}" -C "${MOUNT_POINT}/app" .
  echo "Saved app code backup to ${BACKUP_TAR}"
elif [ ! -f "${BACKUP_TAR}" ]; then
  echo "ERROR: Neither ${MOUNT_POINT}/app nor ${BACKUP_TAR} found! Copy the project to ${MOUNT_POINT}/app first."
  exit 1
fi

echo "=== [2/6] Unmounting ${MOUNT_POINT} and formatting ${DEVICE} as ext4 ==="
cd "$HOME"
sudo umount "${MOUNT_POINT}" 2>/dev/null || true
sudo umount "${DEVICE}" 2>/dev/null || true

sudo mkfs.ext4 -F -L ANCloud "${DEVICE}"

echo "=== [3/6] Updating /etc/fstab with new ext4 UUID and mounting ${MOUNT_POINT} ==="
NEW_UUID=$(sudo blkid -s UUID -o value "${DEVICE}")
sudo mkdir -p "${MOUNT_POINT}"
sudo sed -i "\|${MOUNT_POINT}|d" /etc/fstab
echo "UUID=${NEW_UUID}  ${MOUNT_POINT}  ext4  defaults,noatime,nofail,nodev,nosuid  0  2" | sudo tee -a /etc/fstab

sudo systemctl daemon-reload
sudo mount -a
sudo chown -R "$USER:$USER" "${MOUNT_POINT}"

echo "=== [4/6] Creating HDD directory structure and restoring AN Cloud app ==="
mkdir -p \
  "${MOUNT_POINT}/app" \
  "${MOUNT_POINT}/config" \
  "${MOUNT_POINT}/data/files" \
  "${MOUNT_POINT}/data/database" \
  "${MOUNT_POINT}/data/index" \
  "${MOUNT_POINT}/data/jobs" \
  "${MOUNT_POINT}/data/logs" \
  "${MOUNT_POINT}/data/temp/trash" \
  "${MOUNT_POINT}/data/temp/nginx_body" \
  "${MOUNT_POINT}/data/backups"

tar -xzf "${BACKUP_TAR}" -C "${MOUNT_POINT}/app"

echo "=== [5/6] Installing ARM64 dependencies and building AN Cloud on ext4 ==="
cd "${MOUNT_POINT}/app"
export TMPDIR="${MOUNT_POINT}/data/temp"
npm install --include=dev
npm run build

echo "WD-SCORPIO-BLUE-250GB" > "${MOUNT_POINT}/config/.hdd-identity"

cat <<EOF > "${MOUNT_POINT}/config/.env"
PORT=3000
HOST=0.0.0.0
NODE_ENV=production
STORAGE_ROOT=/mnt/cloud
REQUIRE_MOUNT_CHECK=true
HDD_IDENTITY_TOKEN=WD-SCORPIO-BLUE-250GB
SESSION_SECRET=$(openssl rand -hex 32)
SECURE_COOKIES=false
MAX_UPLOAD_FILE_SIZE_BYTES=10737418240
DEFAULT_GUEST_QUOTA_BYTES=5368709120
MAX_CONCURRENT_GUEST_UPLOADS=3
INDEXER_INTERVAL_MINUTES=30
EOF
chmod 600 "${MOUNT_POINT}/config/.env"

echo "=== [6/6] Starting systemd service and Nginx ==="
chmod +x "${MOUNT_POINT}/app/deploy/verify-hdd-mount.sh"
sudo cp "${MOUNT_POINT}/app/deploy/scorpiocloud.service" /etc/systemd/system/scorpiocloud.service
sudo sed -i "s/User=cloudadmin/User=$USER/g; s/Group=cloudadmin/Group=$USER/g" /etc/systemd/system/scorpiocloud.service
sudo sed -i "s|ExecStartPre=/mnt/cloud/app/deploy/verify-hdd-mount.sh|ExecStartPre=/bin/bash /mnt/cloud/app/deploy/verify-hdd-mount.sh|g" /etc/systemd/system/scorpiocloud.service

sudo systemctl daemon-reload
sudo systemctl enable scorpiocloud.service
sudo systemctl restart scorpiocloud.service
sudo systemctl reload nginx

echo "=== DONE! Health check: ==="
sleep 2
curl http://127.0.0.1/api/v1/health
echo ""
