#!/usr/bin/env bash
# ==============================================================================
# ScorpioCloud — HDD Mount & Identity Verification Guard
# Executed by systemd (ExecStartPre) before starting Node.js
# Ensures zero silent fallback to the Raspberry Pi microSD card.
# ==============================================================================
set -euo pipefail

MOUNT_POINT="${STORAGE_ROOT:-/mnt/cloud}"
IDENTITY_FILE="${MOUNT_POINT}/config/.hdd-identity"

echo "[MountGuard] Checking HDD mount point at ${MOUNT_POINT}..."

if ! mountpoint -q "${MOUNT_POINT}"; then
  echo "[MountGuard] CRITICAL ERROR: ${MOUNT_POINT} is NOT a mounted filesystem! Refusing to start to protect the microSD card." >&2
  exit 1
fi

if [ ! -f "${IDENTITY_FILE}" ]; then
  echo "[MountGuard] CRITICAL ERROR: Identity file ${IDENTITY_FILE} is missing on ${MOUNT_POINT}." >&2
  exit 1
fi

# Verify read/write access on the HDD
PROBE_FILE="${MOUNT_POINT}/data/temp/.systemd-probe-$$"
if ! touch "${PROBE_FILE}" 2>/dev/null; then
  echo "[MountGuard] CRITICAL ERROR: ${MOUNT_POINT} is mounted read-only or experiencing I/O errors." >&2
  exit 1
fi
rm -f "${PROBE_FILE}"

echo "[MountGuard] Verified: External HDD is mounted, identified, and writable at ${MOUNT_POINT}."
exit 0
