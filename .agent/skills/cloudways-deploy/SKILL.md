---
name: cloudways-deploy
description: Deploy files to the Tesseract Academy WordPress site on Cloudways via SSH/SCP
---

# Cloudways Deployment Skill

> **Host**: tesseract.academy is hosted on **Cloudways** (NOT Bluehost).
> Bluehost/cPanel is only for email infrastructure.

## Connection Details

- **Host**: `46.101.94.175` (from `CLOUDWAYS_HOST` env var)
- **User**: `master_jqjeqeuuhw` (from `CLOUDWAYS_USER` env var)
- **Password**: From `CLOUDWAYS_PASS` env var (SSH key auth is also configured)
- **Home directory**: `/mnt/BLOCKSTORAGE/home/master`

## Application Paths

| App | Path |
|-----|------|
| tesseract.academy (primary) | `/mnt/BLOCKSTORAGE/home/master/applications/aaxdypkxet/public_html/` |
| Secondary WP install | `/mnt/BLOCKSTORAGE/home/master/applications/yqdnzffqdp/public_html/` |

### Common Plugin Paths (primary)

```
/mnt/BLOCKSTORAGE/home/master/applications/aaxdypkxet/public_html/wp-content/plugins/wp-membership-plugin-tesseract/
```

## Deploy Commands

### Single File Upload (SCP)

Use `-O` flag for legacy SCP protocol (required for this server):

```bash
scp -O -o StrictHostKeyChecking=no \
  "/local/path/to/file.php" \
  "master_jqjeqeuuhw@46.101.94.175:/mnt/BLOCKSTORAGE/home/master/applications/aaxdypkxet/public_html/wp-content/plugins/<plugin-name>/<path>/file.php"
```

### SSH Command Execution

```bash
ssh -o StrictHostKeyChecking=no master_jqjeqeuuhw@46.101.94.175 "command"
```

### Multiple Files / Directory Sync

```bash
scp -O -o StrictHostKeyChecking=no -r \
  "/local/path/to/directory/" \
  "master_jqjeqeuuhw@46.101.94.175:/remote/path/to/directory/"
```

## Known Gotchas

1. **`sshpass` is NOT installed** on macOS. Use `scp`/`ssh` directly (SSH key auth works).
2. **Use `-O` flag** with `scp` — the server doesn't support the newer SFTP-based SCP protocol.
3. **Path starts with `/mnt/BLOCKSTORAGE/`** — NOT `/home/master/`. The standard Cloudways path `/home/master/applications/...` is a symlink but SCP/SFTP may not resolve it.
4. **Always verify after deploy**: `ssh ... "grep 'expected_string' /path/to/deployed/file.php"`
5. **File permissions**: Deployed files inherit the master user permissions, which is correct for WordPress plugins.
6. **No `expect` needed**: SSH key-based auth works without password prompts for `ssh` and `scp` commands.

## Verification

After deploying, always verify:

```bash
# Check file exists and contains expected changes
ssh -o StrictHostKeyChecking=no master_jqjeqeuuhw@46.101.94.175 \
  "grep -n 'expected_change' /path/to/file.php"

# Quick smoke test via curl
curl -s 'https://tesseract.academy/affected-page/' | grep 'expected_output'
```
