#!/usr/bin/env bash
# ==============================================================================
# AN Cloud — One-Command Instant Rescue & Diagnostic Tool
# Usage: sudo /usr/local/bin/an-cloud-rescue.sh
# ==============================================================================
set -euo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}=== [AN Cloud Rescue & Self-Healing Tool] ===${NC}"

# 1. Mount Check & Repair
echo -e "\n${YELLOW}[1/5] Checking HDD Mount (/mnt/cloud)...${NC}"
if ! mountpoint -q /mnt/cloud; then
  echo "Mount missing! Running mount -a..."
  sudo mount -a || true
fi

if ! mountpoint -q /mnt/cloud; then
  echo "Attempting fallback mount on /dev/sda1..."
  sudo mount /dev/sda1 /mnt/cloud || true
fi

if mountpoint -q /mnt/cloud; then
  echo -e "${GREEN}✓ /mnt/cloud is mounted.${NC}"
else
  echo -e "${RED}✗ CRITICAL: Unable to mount HDD to /mnt/cloud! Check physical cable.${NC}"
  exit 1
fi

# 2. Permissions Check & Repair
echo -e "\n${YELLOW}[2/5] Repairing Permissions and Identity...${NC}"
sudo mkdir -p /mnt/cloud/config /mnt/cloud/data/temp /mnt/cloud/data/logs
echo "WD-SCORPIO-BLUE-250GB" | sudo tee /mnt/cloud/config/.hdd-identity >/dev/null
sudo chown -R anvithgopa:anvithgopa /mnt/cloud
sudo chmod -R 775 /mnt/cloud/data/temp
echo -e "${GREEN}✓ Permissions and identity markers restored.${NC}"

# 3. Clean linger processes
echo -e "\n${YELLOW}[3/5] Cleaning Lingering Processes on Port 3000...${NC}"
sudo fuser -k 3000/tcp 2>/dev/null || true
echo -e "${GREEN}✓ Port 3000 clear.${NC}"

# 4. Restart Services
echo -e "\n${YELLOW}[4/5] Restarting Core Services (Nginx & ScorpioCloud)...${NC}"
sudo systemctl daemon-reload
sudo systemctl restart nginx
sudo systemctl restart scorpiocloud
sleep 4
echo -e "${GREEN}✓ Services restarted.${NC}"

# 5. Live Health Verification
echo -e "\n${YELLOW}[5/5] Running End-to-End Health Probe...${NC}"
HEALTH_RES=$(curl -s http://127.0.0.1:3000/api/v1/health || echo "FAILED")
echo "Health Endpoint Response: ${HEALTH_RES}"

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/api/v1/health || echo "000")
if [ "${HTTP_CODE}" == "200" ]; then
  echo -e "\n${GREEN}======================================================${NC}"
  echo -e "${GREEN}✓ ALL SYSTEMS OPERATIONAL! HTTP 200 OK${NC}"
  echo -e "${GREEN}✓ Access URL: https://anpie.tail8a7be8.ts.net/${NC}"
  echo -e "${GREEN}======================================================${NC}"
else
  echo -e "\n${RED}✗ Warning: Backend returned HTTP ${HTTP_CODE}. Check logs with:${NC}"
  echo "sudo journalctl -u scorpiocloud -n 25 --no-pager"
fi
