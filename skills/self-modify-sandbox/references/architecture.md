# Sandbox Architecture

## Overview

The agent-sandbox is a Docker container that provides an isolated environment for running pi coding agents. It consists of four key files:

| File | Purpose |
|------|---------|
| `Dockerfile` | Builds the `agent-sandbox` image (Debian Trixie, Python 3.13, Node 22, pi) |
| `pi-sandbox` | Host-side launch script: mounts config + working directory into the container |
| `entrypoint` | Container startup: constructs `pi -ne -e <path> ...` from `PI_ENABLED_EXTENSIONS`, symlinks self-modify skills |
| `AGENTS.md` | Documentation for agents about the sandbox environment |

## Directory Layout (inside container)

```
/home/<username>/             # $HOME (username configurable at build time)
├── .pi/                      # Mounted from host $HOME/.pi (read-write)
├── .agent-sandbox/           # Baked into image (ephemeral across restarts)
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

1. **Ephemeral `.agent-sandbox`**: Changes to `$HOME/.agent-sandbox` do not persist across container restarts. Only changes to the Dockerfile and rebuilding the image make permanent changes.

2. **Configurable CWD mount**: The working directory is read-only by default (`-w` for read-write). Use `--no-mount` (`-x`) to skip the CWD mount entirely — the agent works from `/home/<username>` (read-write, image-baked) instead. This prevents accidental host modifications and provides an isolated scratch environment.

3. **Extension opt-in via `-ne`/`-e`**: Extensions are installed via npm into `.agent-sandbox/lib/node_modules/`, then symlinked into `.agent-sandbox/pi-extensions/` (the **catalog** of available extensions). The `pi-sandbox` script builds a `PI_ENABLED_EXTENSIONS` list from user flags and passes it to the container. The entrypoint then invokes `pi -ne -e <path>` for each enabled extension, so only explicitly opted-in extensions are loaded. **Do not add packages to `settings.json`** — control extension enablement via `pi-sandbox` flags.

4. **Self-modification**: When launched with `--self-modify`, the sandbox source directory is mounted at `$HOME/.sandbox-source/` (read-write). The entrypoint auto-discovers the `self-modify-sandbox` skill from this mount.

## Making Permanent Changes

Since `.agent-sandbox` is ephemeral, the only way to make changes that survive container restarts is to:

1. Edit files in `$HOME/.sandbox-source/`
2. Tell the user to rebuild the Docker image on the host:
   ```
   ./pi-build-sandbox
   ```

## Adding a Pi Package (Extension/Skill)

1. Add `npm install -g <package>` to Dockerfile step 8
2. Add a symlink line to Dockerfile step 8:
   ```dockerfile
   && ln -s /home/${SANDBOX_USER}/.agent-sandbox/lib/node_modules/<package> \
           /home/${SANDBOX_USER}/.agent-sandbox/pi-extensions/<package>
   ```
3. Add a flag in `pi-sandbox` that appends the extension name to `ENABLED_EXTENSIONS`
   (e.g., `ENABLED_EXTENSIONS+=(pi-my-new-ext)`) and add the flag to the `--help` text
4. Update `AGENTS.md` with the new package info and flag mapping
5. User must rebuild: `./pi-build-sandbox`

No entrypoint changes are needed — it generically resolves extension names from
`PI_ENABLED_EXTENSIONS` to paths in `~/.agent-sandbox/pi-extensions/`.