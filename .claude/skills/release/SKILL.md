---
name: release
description: Build the project, restart the host service, and rebuild the container image. Triggers on "release", "deploy", "restart nanoclaw", "rebuild and restart".
---

# Release NanoClaw

Build, restart the host service, and rebuild the container — in one shot.

## 1. Build

Run the TypeScript build. **Stop immediately if it fails** — do not restart services with broken code.

```bash
npm run build
```

If the build fails, show the errors and stop. Do not proceed to step 2.

## 2. Test

Run the full test suite. **Stop immediately if any test fails** — do not restart services with untested code.

```bash
npx vitest run
```

If tests fail, show the failures and stop. Do not proceed to step 3.

## 3. Backup

Create a timestamped backup of stateful data before restarting services. The backup **must succeed** — if any copy fails, stop and do not proceed.

```bash
BACKUP_DIR="backups/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"

# Database (the critical state — migrations will modify this on restart)
cp store/messages.db "$BACKUP_DIR/messages.db"

# Compiled output (so we can revert to the previous working build)
cp -r dist "$BACKUP_DIR/dist"
```

Verify the backup is valid:
```bash
# Check the DB copy is not corrupt
sqlite3 "$BACKUP_DIR/messages.db" "PRAGMA integrity_check;" | head -1
```

If the integrity check does not print `ok`, or if any copy command failed, remove the invalid backup and **stop**:

```bash
rm -rf "$BACKUP_DIR"
```

Do not proceed without a valid backup.

Tell the user: `Backup created at $BACKUP_DIR`

## 4. Restart Host Service

Database migrations run automatically when the host starts (`initDatabase()` → `runMigrations()`). Each migration is wrapped in a transaction — if one fails, the host won't start and the database stays in its previous consistent state. Check the logs if the service fails to come back up.

Containers do **not** access the SQLite database directly — they communicate via IPC files that the host processes. So container rebuilds are independent of migration state.

Detect the platform and restart accordingly.

**macOS (launchd):**
```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

**Linux (systemd):**
```bash
systemctl --user restart nanoclaw
```

If neither service manager is available, warn the user and skip to step 5.

## 5. Rebuild Container Image

```bash
./container/build.sh
```

If the container build fails, show the error. The host service is already running with the new code — only the container image is stale.

## 6. Verify

Confirm the host service came back up and migrations applied successfully.

**macOS:**
```bash
launchctl print gui/$(id -u)/com.nanoclaw 2>&1 | head -5
```

**Linux:**
```bash
systemctl --user status nanoclaw --no-pager | head -10
```

Check the log for migration output:
```bash
tail -20 ~/Library/Logs/nanoclaw.log 2>/dev/null || journalctl --user -u nanoclaw -n 20 --no-pager
```

Report success or failure to the user. If the service failed to start, check the log for migration errors — the database will be safe to retry since each migration is atomic.

## Restore from Backup

If anything goes wrong after step 3 (backup), use the backup directory printed during the release to restore the pre-release state.

### 1. Stop the host service

**macOS:**
```bash
launchctl kill SIGTERM gui/$(id -u)/com.nanoclaw
```

**Linux:**
```bash
systemctl --user stop nanoclaw
```

### 2. Restore the database and build

Find the latest valid backup (directories are timestamped, sorted alphabetically):

```bash
BACKUP_DIR=$(ls -d backups/*/ 2>/dev/null | sort -r | head -1)
echo "Restoring from: $BACKUP_DIR"
sqlite3 "${BACKUP_DIR}messages.db" "PRAGMA integrity_check;" | head -1
```

If the integrity check does not print `ok`, try the next most recent backup by repeating with `| head -2 | tail -1`, etc.

Restore:
```bash
cp "${BACKUP_DIR}messages.db" store/messages.db
rm -rf dist && cp -r "${BACKUP_DIR}dist" dist
```

### 3. Restart with the previous version

**macOS:**
```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

**Linux:**
```bash
systemctl --user start nanoclaw
```

### 4. Verify the rollback

```bash
tail -20 ~/Library/Logs/nanoclaw.log 2>/dev/null || journalctl --user -u nanoclaw -n 20 --no-pager
```

Confirm the service is running with the pre-release database. The `schema_migrations` table will reflect the previous migration state since the DB was restored from backup.

## Troubleshooting

### Step 1 — Build fails with type errors
Fix the errors first, then re-run `/release`. No state has changed yet.

### Step 2 — Tests fail
Fix the failing tests, then re-run `/release`. No state has changed yet.

### Step 3 — Backup integrity check fails
The SQLite database may be in use or corrupted. Stop the host service first, then retry:
```bash
launchctl kill SIGTERM gui/$(id -u)/com.nanoclaw  # macOS
# or: systemctl --user stop nanoclaw               # Linux
cp store/messages.db "$BACKUP_DIR/messages.db"
sqlite3 "$BACKUP_DIR/messages.db" "PRAGMA integrity_check;"
```
If it still fails, the live database itself may be corrupt — investigate before proceeding.

### Step 4 — Host fails to start after migration
Follow the "Restore from Backup" section above to roll back. Then fix the migration code, rebuild, and retry `/release`.

### Step 4 — Service not found
The service plist/unit may not be installed yet. Run `/setup` to configure it.

### Step 5 — Container build fails
The host service is already running with the new code — only the container image is stale. Try pruning the builder cache:
```bash
docker builder prune -f
./container/build.sh
```
For Apple Container setups, check that the container runtime is running.

### Step 6 — Verify shows service not running
Check the logs for errors:
```bash
tail -50 ~/Library/Logs/nanoclaw.log 2>/dev/null || journalctl --user -u nanoclaw -n 50 --no-pager
```
If the error is migration-related, follow "Restore from Backup". Otherwise, use `/debug` to investigate.
