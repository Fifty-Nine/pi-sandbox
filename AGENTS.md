# Agent Sandbox

A Docker-based sandbox for running `pi-coding-agent` in an isolated environment.

## Files

| File | Purpose |
|---|---|
| `Dockerfile` | Builds the `agent-sandbox` image (Debian Trixie, pyenv/Python 3.13, Node 22, pi-coding-agent) |
| `sandbox` | Launch script that mounts config + working directory into the container |
| `entrypoint` | Container entrypoint: sets up extension symlinks, skill symlinks, then execs CMD |
| `AGENTS.md` | This file |
| `skills/self-modify-sandbox/` | Pi skill for sandbox self-modification (loaded when `--self-modify` is active) |
| `packages/pi-tmux-debug/` | Local pi package providing tmux interaction tool and debugging skill |

## Docker Image (`agent-sandbox`)

- **Base:** `debian:trixie-slim`
- **Languages:** Python 3.13 (via pyenv), Node.js 22 (via NodeSource)
- **User:** Configurable at build time (defaults to the building user's UID/GID/name). Inside the container, the home directory is `/home/<username>/.agent-sandbox`. See **Build** below.
- **npm global prefix:** `/home/<username>/.agent-sandbox` (global modules installed there)
- **Entry command:** `pi` (from `@mariozechner/pi-coding-agent`)

### Build

The `build` script accepts options to customize the sandbox user to match the host user, ensuring correct file ownership for bind mounts:

```bash
# Default: use the current host user's UID, GID, username, and group name
./build

# Customize the sandbox user
./build --uid 1000 --gid 1000 --username alice --groupname alice

# Show help
./build --help
```

| Option | Default | Description |
|--------|---------|-------------|
| `--uid` | `$(id -u)` | User ID inside the container |
| `--gid` | `$(id -g)` | Group ID inside the container |
| `--username` | `$(id -un)` | Username inside the container |
| `--groupname` | `$(id -gn)` | Group name inside the container |

These values are passed as Docker `--build-arg`s and baked into the image. The username is also stored as a Docker label (`sandbox.user`) so the `sandbox` launch script can auto-detect it.

You can also invoke `docker build` directly with the build args:

```bash
docker build --build-arg SANDBOX_UID=1000 --build-arg SANDBOX_GID=1000 \
             --build-arg SANDBOX_USER=alice --build-arg SANDBOX_GROUP=alice \
             -t agent-sandbox .
```

## Launch Script (`sandbox`)

Runs the container with bind mounts so the agent sees the host project directory and your pi configuration.

### Mounts

| Host path | Container path | Mode |
|---|---|---|
| `$HOME/.pi` | `/home/<username>/.pi` | read-write |
| `$PWD` | `/home/<username>/<relative>` | read-only (default), skipped with `--no-mount` |
| Sandbox source (if `--self-modify`) | `/home/<username>/.sandbox-source` | read-write |

`/home/<username>/.agent-sandbox` is **not** mounted from the host. It is baked into the Docker image and is container-ephemeral: the agent can write to it freely during a session, but changes do not persist across container restarts.

`$PWD` is remapped by replacing the `$HOME` prefix with `/home/<username>`. For example, if you are in `/home/princet/my-project` and the sandbox user is `alice`, it mounts at `/home/alice/my-project`, and the agent's working directory is set there.

### Usage

```bash
# Read-only mount (default) — agent can read but not modify your files
./sandbox

# Read-write mount — agent can modify files in the working directory
./sandbox -w
./sandbox --read-write

# No mount — skip CWD mount entirely; agent works in /home/<username> (read-write)
./sandbox -x
./sandbox --no-mount

# Self-modify mode — mount sandbox source + load self-modify skill
./sandbox -s
./sandbox --self-modify

# Combine flags
./sandbox -s -w
./sandbox -s -x

# Override the container command
./sandbox -- bash
./sandbox -w -- bash
```

## Pi Package Extensions

Pi packages (npm packages with pi extensions/skills/prompts) are installed in
the Dockerfile and discovered at runtime via an entrypoint script:

1. **Install via npm** in the Dockerfile (step 8)
2. **Symlink** into `/home/<username>/.agent-sandbox/pi-extensions/` (Dockerfile step 8)
3. The **entrypoint script** iterates `pi-extensions/` at startup and creates matching
   symlinks in `~/.pi/agent/extensions/`, where pi auto-discovers them

The `pi-extensions/` directory is a symlink farm — each subdirectory points to the
package's actual location in the global `node_modules/`. The entrypoint bridges
this farm into `~/.pi/agent/extensions/` (which is on the mounted `~/.pi` volume),
so **settings.json never needs updating when packages are added or removed** —
just add/remove the npm install + symlink in the Dockerfile.

> **Why not `settings.json` `extensions` glob?** The `extensions` setting in
> settings.json treats entries with `*` as enable/disable patterns for already-
> discovered extensions, not as path globs for discovering new extensions. Putting
> a glob like `/path/pi-extensions/*` in `extensions` results in no extensions being
> loaded because there are no auto-discovered paths for the pattern to match.

Current packages:

| Package | Purpose |
|---------|--------|
| `pi-ask-user` | Interactive `ask_user` tool with searchable selection UI |
| `pi-tmux-debug` | Tmux interaction tool (`capture-pane`, `send-keys`, etc.) + `tmux-debug` skill |

**To add a new pi package:**
1. For **npm packages**: add `npm install -g <package>` and a symlink line to Dockerfile step 8
2. For **local packages** (in `packages/`): add COPY + `npm install -g` + symlink to Dockerfile (see step 8b)
3. Add a row to the table above
4. Rebuild the image

## Self-Modification

With `--self-modify` (or `-s`), the sandbox mounts its own source directory
read-write at `/home/<username>/.sandbox-source` and sets `SANDBOX_SELF_MODIFY=1`.
The entrypoint script then symlinks the `self-modify-sandbox` skill from the
mounted source into `~/.pi/agent/skills/`, making it available to the agent.

The skill provides:
- Awareness of all sandbox source files and their purposes
- Validation scripts (`scripts/validate.sh`) to check edits before rebuild
- Status/diff scripts to review changes
- Instructions to notify the user that a `docker build` is needed on the host

The agent **cannot rebuild the Docker image** from inside the container
(Docker socket is not mounted for security). After making changes, the agent
should tell the user to run `docker build -t agent-sandbox .` on the host.

## Tmux Debug Mode

With `--tmux [<socket-path>]`, the sandbox mounts a host tmux session socket
into the container, enabling the `tmux` tool (from `pi-tmux-debug`) to interact
with a user-provided tmux session.

- If no socket path is given and `$TMUX` is set, the socket is auto-detected from `$TMUX`
- Otherwise defaults to `/tmp/tmux-$(id -u)/default`
- The socket's parent directory is bind-mounted at a fixed path (`/tmux-socket-dir/`)
  inside the container, and `TMUX_SOCKET_PATH` points to the socket within it
- `TMUX_SOCKET_PATH` env var is set so the `tmux` tool knows which socket to use
- `TMUX_DEBUG_MODE=1` env var is set (reserved for future tool-restriction behavior)

> **Why mount the directory, not the socket file?** Docker bind mounts of
> individual Unix socket files don't reliably share the live socket inode — the
> container sees a stale copy. Mounting the parent directory ensures the
> container accesses the same live socket the host tmux server is bound to.

```bash
# Auto-detect socket from current tmux session
./sandbox --tmux

# Specify socket explicitly
./sandbox --tmux /tmp/tmux-1000/default

# Combine with other flags
./sandbox --tmux -w
```

**Important compatibility notes:**

1. **UID match:** The container runs as the UID configured at build time (defaults
   to the building user's UID). The tmux server checks the connecting client's UID
   and rejects mismatches. The host tmux server must be running as the same UID.
   If the socket is owned by a different UID, the agent cannot connect.

2. **Tmux version:** The container builds tmux from source (currently 3.6) to
   ensure protocol compatibility with the host tmux server. Debian Trixie's
   packaged tmux (3.5a) uses an incompatible IPC protocol with tmux 3.6+ servers.
   If the host runs a newer tmux version, update the `TMUX_VERSION` build arg in
   the Dockerfile accordingly.

## Notes

- The working directory mount is **read-only by default** to prevent unintended host modifications. Use `-w` only when you explicitly want the agent to write back to the host filesystem. Use `--no-mount` (`-x`) to skip the CWD mount entirely — the agent's working directory falls back to `/home/<username>`, which is read-write (baked into the image, not a host mount).
- `$HOME/.pi` is always mounted read-write so the agent can persist config, history, and session state.
- `/home/<username>/.agent-sandbox` is baked into the Docker image (not a host mount). It is writable by the agent during a session but changes are **ephemeral** — they do not persist across container restarts.
- `npm` is configured (via `NPM_CONFIG_PREFIX`) to install global packages into `/home/<username>/.agent-sandbox`. This means `npm install -g` places modules in `/home/<username>/.agent-sandbox/lib/node_modules/` and binaries in `/home/<username>/.agent-sandbox/bin/` (which is on `PATH`).
- Pi packages are discovered via symlinks in `~/.pi/agent/extensions/` created by the entrypoint script at startup. The entrypoint reads from the `pi-extensions/` symlink farm baked into the image. Do **not** add individual packages to `settings.json` — add them to the Dockerfile symlink farm instead (see "Pi Package Extensions" above).

## AGENTS.md

Agents are encouraged to keep AGENTS.md up-to-date with recent changes, in
particular when new changes would break existing workflows or introduce
potential confusion for agents in the future.
