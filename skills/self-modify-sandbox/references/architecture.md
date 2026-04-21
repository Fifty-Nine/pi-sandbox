# Sandbox Architecture

## Overview

The pi-sandbox is a Docker container that provides an isolated environment for running pi coding agents. It consists of four key files:

| File | Purpose |
|------|---------|
| `Dockerfile` | Builds the `pi-sandbox` image (Debian Trixie, Python 3.13, Node 22, pi) |
| `pi-sandbox` | Host-side launch script: mounts config + working directory into the container |
| `entrypoint` | Container startup: symlinks pi extensions into `~/.pi/agent/extensions/` |
| `AGENTS.md` | Documentation for agents about the sandbox environment |

## Directory Layout (inside container)

```
/home/<username>/             # $HOME (username configurable at build time)
├── .pi/                      # Mounted from host $HOME/.pi (read-write)
├── .pi-sandbox/           # Baked into image (ephemeral across restarts)
│   ├── bin/                  # npm global binaries (on PATH)
│   ├── lib/node_modules/     # npm global packages
│   └── pi-extensions/        # Symlink farm → node_modules packages
├── .sandbox-source/          # Only present with --self-modify flag
│   └── (sandbox repo files)  # Mounted read-write from host
└── <project>/                # Working directory (mounted from host $PWD)
                              #   Default: read-only | -w: read-write | -x: not mounted
                              #   When not mounted, CWD falls back to /home/<username>
```

## Key Design Decisions

1. **Ephemeral `.pi-sandbox`**: Changes to `$HOME/.pi-sandbox` do not persist across container restarts. Only changes to the Dockerfile and rebuilding the image make permanent changes.

2. **Configurable CWD mount**: The working directory is read-only by default (`-w` for read-write). Use `--no-mount` (`-x`) to skip the CWD mount entirely — the agent works from `/home/<username>` (read-write, image-baked) instead. This prevents accidental host modifications and provides an isolated scratch environment.

3. **Pi packages via symlink farm**: Extensions are installed via npm into `.pi-sandbox/lib/node_modules/`, then symlinked into `.pi-sandbox/pi-extensions/`. The entrypoint script bridges these into `~/.pi/agent/extensions/` for pi auto-discovery. **Do not add packages to `settings.json`** — add them to the Dockerfile symlink farm.

4. **Self-modification**: When launched with `--self-modify`, the sandbox source directory is mounted at `$HOME/.sandbox-source/` (read-write). The entrypoint auto-discovers the `self-modify-sandbox` skill from this mount.

## Making Permanent Changes

Since `.pi-sandbox` is ephemeral, the only way to make changes that survive container restarts is to:

1. Edit files in `$HOME/.sandbox-source/`
2. Tell the user to rebuild the Docker image on the host:
   ```
   ./pi-build-sandbox
   ```

## Adding a Pi Package (Extension/Skill)

1. Add `npm install -g <package>` to Dockerfile step 8
2. Add a symlink line to Dockerfile step 8:
   ```dockerfile
   && ln -s /home/${SANDBOX_USER}/.pi-sandbox/lib/node_modules/<package> \
           /home/${SANDBOX_USER}/.pi-sandbox/pi-extensions/<package>
   ```
3. Update `AGENTS.md` with the new package info
4. User must rebuild: `./pi-build-sandbox`
