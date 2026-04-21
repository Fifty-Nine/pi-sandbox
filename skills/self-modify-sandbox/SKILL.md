---
name: self-modify-sandbox
description: Modify the pi-sandbox Docker environment (Dockerfile, entrypoint, launch script, AGENTS.md). Use when the user asks to change sandbox configuration, add/remove packages, update the Docker image definition, or modify sandbox behavior.
compatibility: Requires --self-modify flag on sandbox launch script
---

# Self-Modify Sandbox

This skill lets you modify the pi-sandbox environment from *inside* the running container.

## Prerequisites

This skill is only available when the sandbox was launched with `--self-modify`. Check:

```bash
echo $SANDBOX_SELF_MODIFY  # should be "1"
ls $HOME/.sandbox-source/Dockerfile  # should exist
```

If these aren't set, the user must relaunch with `./pi-sandbox --self-modify`.

## Sandbox Source Location

All sandbox source files are at `$HOME/.sandbox-source/`:

| File | Purpose |
|------|---------|
| `Dockerfile` | Docker image definition (packages, users, env vars) |
| `pi-sandbox` | Host-side launch script (mounts, flags, Docker run). CWD mount is optional (`--no-mount`) |
| `entrypoint` | Container entrypoint (extension symlinks, CMD exec) |
| `AGENTS.md` | Documentation for agents (you are reading a derivative of this) |
| `skills/` | Pi skills bundled with the sandbox (including this one) |

Changes you make here persist on the host filesystem (the directory is a bind mount).

## How to Make Changes

### 1. Edit the relevant file

Use `edit` or `write` on files under `$HOME/.sandbox-source/`.

**Dockerfile** — Add packages, change base image, add build steps:
```bash
# Example: Add a new apt package
# Edit the RUN apt-get install line in step 1
```

**entrypoint** — Change container startup behavior, add extension discovery:
```bash
# Example: Add a new pi package symlink
# Add to the pi-extensions section
```

**pi-sandbox** — Change host-side launch behavior, add mount flags:
```bash
# Example: Add a new mount or flag
# Edit the docker run invocation
```

### 2. Add pi packages

To add a new npm pi package:

1. Add `npm install -g <package>` to Dockerfile step 8
2. Add a symlink in Dockerfile step 8: `&& ln -s $HOME/.pi-sandbox/lib/node_modules/<package> $HOME/.pi-sandbox/pi-extensions/<package>`
3. Update the "Current packages" table in AGENTS.md
4. Rebuild the image (user does this on the host)

### 3. Validate changes

Before telling the user to rebuild, validate your changes:

```bash
$HOME/.sandbox-source/skills/self-modify-sandbox/scripts/validate.sh
```

This checks:
- Dockerfile syntax (via `dockerfile-parse` or basic lint)
- That referenced pi-extensions symlinks match npm install lines
- That the entrypoint is syntactically valid bash

### 4. Tell the user to rebuild

After making changes, inform the user:

> I've modified the sandbox source files. To apply changes, rebuild the Docker image on your host:
>
> ```bash
> ./pi-build-sandbox
> ```
>
> Then restart the sandbox with `./pi-sandbox --self-modify`.

## Important Constraints

- **You cannot rebuild the image from inside the container.** The Docker socket is not mounted (by design, for security). Changes take effect on the *next* container session after the user rebuilds.
- **Do not modify `$HOME/.pi-sandbox/`** — that's the ephemeral in-image directory. Changes there are lost on rebuild. Always edit `$HOME/.sandbox-source/` instead.
- **Keep AGENTS.md updated** — After making structural changes, update AGENTS.md so future agents understand the new state.
- **Test the Dockerfile carefully** — A broken Dockerfile means the sandbox can't start. Use `validate.sh` before handing off.

## Architecture Reference

For detailed architecture documentation, see [architecture.md](references/architecture.md).
