# AN Cloud — Self-Hosted Personal Cloud Drive for Raspberry Pi 4

AN Cloud is a custom-developed, self-hosted personal cloud storage application designed specifically for a **Raspberry Pi 4** connected to a physical **WD Scorpio Blue 250GB SATA HDD** via a USB enclosure.

It delivers a Google Drive-style file manager, live hardware & storage telemetry dashboard, background HDD indexing, streaming uploads/downloads, and **secure public download & guest dropzone upload links that do not require recipients to create an account or log in**.

---

## 1. Architecture & Storage Guarantee (`/mnt/cloud`)

All application code, SQLite metadata, user files, temporary upload streams, trash, background jobs, logs, and database backups reside strictly on the physical HDD mounted at `/mnt/cloud`:

```text
/mnt/cloud/
├── app/                   # Application source, dist build, and node_modules
├── config/                # .env secrets and .hdd-identity hardware verification marker
└── data/
    ├── files/             # Physical user & guest uploaded files (UUID collision-safe storage names)
    ├── database/          # SQLite WAL database (cloud.sqlite)
    ├── index/             # Background indexer state snapshots (latest-scan.json)
    ├── jobs/              # Background job logs & queues
    ├── logs/              # Application and error logs
    ├── temp/              # Streaming upload part files, trash bin, and Nginx body temp
    └── backups/           # Consistent hot SQLite backups
```

### What Remains on the microSD Card vs. RAM vs. Physical HDD

| Layer | Location | Purpose |
| :--- | :--- | :--- |
| **microSD Card** | `/boot`, `/etc/fstab`, `/etc/systemd/system/scorpiocloud.service`, `/etc/nginx/` | Raspberry Pi OS Lite 64-bit kernel, boot files, systemd unit file, and Nginx reverse proxy config only. Zero user files, zero SQLite databases, and zero upload temporary files are ever written to the microSD card. |
| **RAM (Raspberry Pi 4)** | Process memory (`--max-old-space-size=512`) | Node.js event loop, 64 KB streaming I/O chunk buffers, and Argon2id hashing (`19 MB` memory cost). Complete files or ZIP archives are **never** buffered into RAM. |
| **WD Scorpio Blue HDD** | `/mnt/cloud/...` | 100% of uploaded files, SQLite tables, sessions, share token hashes, audit logs, temporary upload streams, and backups. |

### Startup & Runtime Mount Guards (Zero Silent microSD Fallback)
1. **Systemd Guard**: `scorpiocloud.service` enforces `RequiresMountsFor=/mnt/cloud`, `ConditionPathIsMountPoint=/mnt/cloud`, and runs `deploy/verify-hdd-mount.sh` (`ExecStartPre`) before starting Node.js.
2. **Application Device ID & Identity Guard**: `src/server/storage/mountGuard.ts` compares the POSIX device ID (`stat.dev`) of `/mnt/cloud` against `/mnt`, verifies `/mnt/cloud/config/.hdd-identity`, and performs a live write probe before every upload or mutation. If the HDD is disconnected, unmounted, or remounted read-only, storage operations immediately halt with `503 Service Unavailable` rather than writing to the `/mnt/cloud` folder on the microSD card.

---

## 2. Local Development & Testing

### Install & Run Development Server
```bash
npm install
npm run dev
```
- Frontend dev server: `http://localhost:5173`
- Backend API server: `http://localhost:3000` (uses `.local-cloud/` in development mode)

### Production Build & Automated Verification
```bash
# Build React frontend and TypeScript backend
npm run build

# Run Vitest + Supertest backend & security acceptance suite
npm test

# Run Playwright End-to-End browser suite
npm run test:e2e
```

---

## 3. Step-by-Step Deployment on Raspberry Pi 4

### Step 1: Prepare Raspberry Pi OS Lite (64-bit) & ARM64 Node.js LTS
SSH into your Raspberry Pi 4 and install Node.js 20 LTS (ARM64), Nginx, and build tools for native SQLite/Argon2 modules:

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git nginx build-essential python3 sqlite3 openssl
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v && npm -v
```

### Step 2: Mount the WD Scorpio Blue 250GB HDD by UUID (Without Formatting)
> **IMPORTANT**: Do **not** format or repartition your HDD if it already has an `ext4` filesystem and data.

1. Plug in the USB SATA enclosure (use a **powered USB hub** if the enclosure draws peak spin-up current exceeding Raspberry Pi USB port limits).
2. Identify the partition UUID and filesystem type:
   ```bash
   lsblk -f
   sudo blkid
   ```
3. Create the mount point and make the underlying directory immutable on the microSD card so nothing can ever write to it when unmounted:
   ```bash
   sudo mkdir -p /mnt/cloud
   sudo chattr +i /mnt/cloud
   ```
4. Add the persistent UUID mount to `/etc/fstab` (replace `YOUR-EXT4-UUID-HERE` with the UUID from `blkid`). Note `nodev,nosuid` for hardware security:
   ```fstab
   UUID=YOUR-EXT4-UUID-HERE  /mnt/cloud  ext4  defaults,noatime,nofail,nodev,nosuid,errors=remount-ro  0  2
   ```
5. Mount the drive:
   ```bash
   sudo chattr -i /mnt/cloud
   sudo mount -a
   df -h /mnt/cloud
   ```

### Step 3: Install Application onto the HDD (`/mnt/cloud/app`)
Copy or clone this repository into `/mnt/cloud/app`, install dependencies, and compile:

```bash
sudo mkdir -p /mnt/cloud/app
sudo chown -R $USER:$USER /mnt/cloud
rsync -av --exclude 'node_modules' --exclude '.local-cloud' ./ /mnt/cloud/app/
cd /mnt/cloud/app
npm ci
npm run build
```

### Step 4: Run the Provisioning Script (`setup-pi.sh`)
Run the included provisioning script to create the `cloudadmin` service user, initialize `/mnt/cloud/data/...` directories, generate `/mnt/cloud/config/.env` and `.hdd-identity`, register `scorpiocloud.service`, and configure Nginx:

```bash
chmod +x /mnt/cloud/app/deploy/setup-pi.sh /mnt/cloud/app/deploy/verify-hdd-mount.sh
/mnt/cloud/app/deploy/setup-pi.sh
sudo systemctl start scorpiocloud
sudo systemctl status scorpiocloud
```

---

## 4. Worldwide Remote Access & Public Share Links (No Paid Hosting)

Because ScorpioCloud is hosted on your Raspberry Pi 4 at home, you have two complementary ways to access it globally at zero cost:

### Option A: Private Mesh Access via Tailscale (Recommended for Admin & Personal Devices)
1. Install Tailscale on the Raspberry Pi:
   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```
2. Enable **Tailscale HTTPS** in your Tailscale admin console and run:
   ```bash
   sudo tailscale serve --bg 3000
   ```
   You can now access your drive privately from anywhere in the world via `https://<pi-name>.<tailnet>.ts.net`.

### Option B: Public HTTPS Access for Anonymous Share Links (`/s/:token`)
To let friends, family, or clients open `/s/:token` download and guest upload links from anywhere without installing VPN software:

1. **Cloudflare Tunnel (`cloudflared`)** *(Works behind CGNAT without opening router ports)*:
   - Install `cloudflared` on the Raspberry Pi (`arm64`) and point your tunnel hostname to `http://127.0.0.1:80` (Nginx).
   - Set `SECURE_COOKIES=true` in `/mnt/cloud/config/.env` and restart `scorpiocloud`.
2. **Dynamic DNS (DuckDNS) + Router Port Forwarding (443 -> Pi) + Let's Encrypt (`certbot --nginx`)**:
   - Forward TCP ports `80` and `443` on your home router to the Raspberry Pi's LAN IP.
   - Never expose port `3000` directly to the internet; always route through Nginx with TLS.

### Home Hosting Limitations to Keep in Mind
- **Home Internet Upload Bandwidth**: When someone downloads a file from your Raspberry Pi remotely, the transfer speed is bounded by your ISP's **upload** speed (and when a guest uploads a file to your Pi, it is bounded by your ISP's download speed and USB 2.0/3.0 SATA throughput).
- **Power Availability**: A sudden power outage can interrupt active transfers. SQLite WAL mode and atomic temp-to-final file renames protect database and file integrity, and systemd restarts the service automatically once power returns.
- **Mechanical HDD Reliability**: The WD Scorpio Blue 250GB is a mechanical 2.5" 5400 RPM SATA drive. Monitor SMART health (`sudo apt install smartmontools && sudo smartctl -a /dev/sda`) and keep regular off-drive backups of critical files.

---

## 5. Backup and Recovery Instructions

### Creating a Hot Backup
- **From the Web UI**: Navigate to **Settings → Consistent SQLite Backups on HDD** and click **Create Backup Now**.
- **From the CLI / Cron**:
  ```bash
  cd /mnt/cloud/app
  STORAGE_ROOT=/mnt/cloud npm run db:backup
  ```
  Backups are written to `/mnt/cloud/data/backups/cloud-db-backup-<timestamp>.sqlite`.

### Restoring from a Backup
1. Stop the running service:
   ```bash
   sudo systemctl stop scorpiocloud
   ```
2. Run the restore script (automatically verifies `PRAGMA integrity_check` before replacing the database):
   ```bash
   cd /mnt/cloud/app
   STORAGE_ROOT=/mnt/cloud npm run db:restore
   ```
3. Start the service and run a physical HDD rescan from the Dashboard:
   ```bash
   sudo systemctl start scorpiocloud
   ```
