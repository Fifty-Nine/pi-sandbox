# Agent Sandbox

A Podman-based sandbox for running `pi-coding-agent` in an isolated environment.

## Files

| File | Purpose |
|---|---|
| `Dockerfile` | Builds the `pi-sandbox` image (Debian Trixie, pyenv/Python 3.13, Node 22, pi-coding-agent) |
| `pi-sandbox` | Launch script that mounts config + working directory into the container |
| `entrypoint` | Container entrypoint: sets up extension symlinks, skill symlinks, then execs CMD |
| `AGENTS.md` | This file |
| `skills/self-modify-sandbox/` | Pi skill for sandbox self-modification (loaded when `--self-modify` is active) |
| `packages/pi-tmux-debug/` | Local pi package providing tmux interaction tool and debugging skill |

## Container Runtime

The sandbox uses **rootless Podman** as its container runtime. `docker` is not required.
Rootless Podman is used in preference to rootless Docker because Podman supports
`--userns=keep-id`, which maps the host user's UID/GID directly into the container at
the same numeric value. This ensures files created by the agent on bind-mounted volumes
(e.g. `~/.pi`, `-w` CWD mounts) appear with correct ownership on the host, without
requiring any UID/GID remapping logic in the image or entrypoint.

Podman coexists cleanly with Docker — installing Podman does not affect existing Docker
daemon, docker-compose stacks, or Docker images.

## Container Image (`pi-sandbox`)

- **Base:** `debian:trixie-slim`
- **Languages:** Python 3.13 (via pyenv), Node.js 22 (via NodeSource)
- **User:** Configurable at build time (defaults to the building user's UID/GID/name). Inside the container, the home directory is `/home/<username>/.pi-sandbox`. See **Build** below.
- **npm global prefix:** `/home/<username>/.pi-sandbox` (global modules installed there)
- **Entry command:** `pi` (from `@mariozechner/pi-coding-agent`)

### Build

The `pi-build-sandbox` script wraps `podman build` and accepts options to customize the
sandbox user to match the host user. With rootless Podman + `--userns=keep-id`, the baked-in
UID/GID must match the host user running the sandbox — the default (current user) is correct
for the common single-user case:

```bash
# Default: use the current host user's UID, GID, username, and group name
./pi-build-sandbox

# Customize the sandbox user
./pi-build-sandbox --uid 1000 --gid 1000 --username alice --groupname alice

# Show help
./pi-build-sandbox --help
```

| Option | Default | Description |
|--------|---------|-------------|
| `--uid` | `$(id -u)` | User ID inside the container |
| `--gid` | `$(id -g)` | Group ID inside the container |
| `--username` | `$(id -un)` | Username inside the container |
| `--groupname` | `$(id -gn)` | Group name inside the container |

These values are passed as `--build-arg`s and baked into the image. The username is also
stored as an image label (`sandbox.user`) so the `pi-sandbox` launch script can auto-detect
it via `podman image inspect`.

## Launch Script (`pi-sandbox`)

Runs the container via `podman run -it --rm --userns=keep-id` with bind mounts so the agent
sees the host project directory and your pi configuration.

`--userns=keep-id` is the key flag: it tells Podman to configure the user namespace so that
the host user's UID/GID maps to the same UID/GID inside the container, rather than to the
default rootless mapping (where non-root container UIDs end up in the subordinate UID range
on the host). This means bind-mounted files are always owned by the correct host user.

### Mounts

| Host path | Container path | Mode |
|---|---|---|
| `$HOME/.pi` | `/home/<username>/.pi` | read-write |  |
| `$PWD` | `/home/<username>/<relative>` | read-only (default), skipped with `--no-mount` |
| `$HOME/.ssh` (if `--ssh`) | `/home/<username>/.ssh` | read-only |
| SSH agent socket (if `--ssh`) | `/ssh-agent-socket/<basename>` | read-write (bind mount of socket directory) |
| Sandbox source (if `--self-modify`) | `/home/<username>/.sandbox-source` | read-write |

`/home/<username>/.pi-sandbox` is **not** mounted from the host. It is baked into the container image and is container-ephemeral: the agent can write to it freely during a session, but changes do not persist across container restarts.


The entrypoint builds a shadow agent dir at `/home/<username>/.pi-sandbox/pi-agent/` and
sets `PI_CODING_AGENT_DIR` to point pi there instead of `~/.pi/agent/`. The shadow dir
has its own `settings.json` (host settings with `packages` stripped) and `extensions/`
(sandbox-only symlinks), while everything else — `auth.json`, `sessions/`, `bin/`,
`skills/`, `models.json` — is symlinked back to the real `~/.pi/agent/` so credentials,
session history, and skills remain accessible and new sessions persist to the host.

`$PWD` is remapped by replacing the `$HOME` prefix with `/home/<username>`. For example, if you are in `/home/princet/my-project` and the sandbox user is `alice`, it mounts at `/home/alice/my-project`, and the agent's working directory is set there.

### Usage

```bash
# Default: pi with only pi-ask-user extension (read-only mount)
./pi-sandbox

# Read-write mount — agent can modify files in the working directory
./pi-sandbox -w
./pi-sandbox --read-write

# No mount — skip CWD mount entirely; agent works in /home/<username> (read-write)
./pi-sandbox -x
./pi-sandbox --no-mount

# Self-modify mode — mount sandbox source + load self-modify skill
./pi-sandbox -s
./pi-sandbox --self-modify

# SSH mode — forward SSH agent + mount ~/.ssh read-only for remote host access
./pi-sandbox -S
./pi-sandbox --ssh

# Tmux debug mode — mount tmux socket + enable pi-tmux-debug extension
./pi-sandbox --tmux
./pi-sandbox --tmux /tmp/tmux-1000/default

# Disable pi-ask-user (pi-searxng still enabled)
./pi-sandbox --no-ask-user

# Pass additional pi arguments after --
./pi-sandbox -- --resume                  # pi -ne -e pi-ask-user -e pi-searxng --resume
./pi-sandbox --tmux -- --resume            # pi -ne -e pi-ask-user -e pi-searxng -e pi-tmux-debug --resume

# Override the container command entirely
./pi-sandbox -- bash
./pi-sandbox -w -- bash

# Combine flags
./pi-sandbox -s -w
./pi-sandbox -s -x
./pi-sandbox -S -w
./pi-sandbox -S --tmux
```

## Extension Opt-In System

Sandbox extensions are **disabled by default** and must be explicitly enabled
via `pi-sandbox` flags, except for `pi-ask-user` and `pi-searxng` which are
enabled by default. This gives users fine-grained control over which
capabilities the agent has access to.

### How It Works

The `pi-sandbox` script builds a list of enabled extensions based on user flags
and passes it to the container via the `PI_ENABLED_EXTENSIONS` environment
variable. The container entrypoint then invokes pi with `-ne` (disable
auto-discovery) and `-e <path>` for each enabled extension, so only explicitly
opted-in extensions are loaded.

The `~/.pi-sandbox/pi-extensions/` directory (baked into the image) serves
as the **catalog** of available extensions — each subdirectory is a symlink to
the package's actual location in the global `node_modules/`. The entrypoint
resolves enabled extension names to paths in this directory and builds the
appropriate `-e` flags.

> **User's own host extensions:** With `-ne`, extensions in
> `~/.pi/agent/extensions/` (mounted from the host) are not auto-discovered.
> This is intentional — the sandbox is a controlled, opt-in environment.
> If you need a host extension, pass it explicitly:
> `pi-sandbox -- -e ~/.pi/agent/extensions/my-ext`

### Extension Flags

| Flag | Extensions enabled | Notes |
|------|-------------------|-------|
| *(default)* | `pi-ask-user`, `pi-searxng` | Default extensions are always on unless explicitly disabled |
| `--tmux [SOCKET]` | `pi-ask-user`, `pi-searxng`, `pi-tmux-debug` | Also mounts tmux socket |
| `--tmux-ssh HOST` | `pi-ask-user`, `pi-searxng`, `pi-tmux-debug` | Proxies tmux over SSH |
| `--no-ask-user` | `pi-searxng` | Disables only `pi-ask-user`; other defaults remain |
| `--no-searxng` | `pi-ask-user` | Disables only `pi-searxng`; other defaults remain |
| `--no-ask-user --no-searxng` | *(none)* | Disables all default extensions |

### Example Invocations

| `pi-sandbox` command | Actual `pi` command in container |
|---|---|
| `pi-sandbox` | `pi -ne -e .../pi-ask-user -e .../pi-searxng` |
| `pi-sandbox --tmux` | `pi -ne -e .../pi-ask-user -e .../pi-searxng -e .../pi-tmux-debug` |
| `pi-sandbox --tmux-ssh host -S` | `pi -ne -e .../pi-ask-user -e .../pi-searxng -e .../pi-tmux-debug` |
| `pi-sandbox --no-ask-user` | `pi -ne -e .../pi-searxng` |
| `pi-sandbox --no-searxng` | `pi -ne -e .../pi-ask-user` |
| `pi-sandbox --no-ask-user --no-searxng` | `pi -ne` (no extensions) |
| `pi-sandbox -- --resume` | `pi -ne -e .../pi-ask-user -e .../pi-searxng --resume` |
| `pi-sandbox -- -e /my/ext` | `pi -ne -e .../pi-ask-user -e .../pi-searxng -e /my/ext` |
| `pi-sandbox -- bash` | `bash` (not pi) |

Current packages:

| Package | Purpose | Enabled by |
|---------|---------|------------|
| `pi-ask-user` | Interactive `ask_user` tool with searchable selection UI | default (disable with `--no-ask-user`) |
| `pi-searxng` | SearXNG web search tool for the agent | default (disable with `--no-searxng`) |
| `pi-tmux-debug` | Tmux interaction tool (`capture-pane`, `send-keys`, etc.) + `tmux-debug` skill | `--tmux` or `--tmux-ssh` |

### Adding a New Extension

To add a new pi package to the sandbox:

1. **Install the package** in the Dockerfile:
   - For **npm packages**: add `npm install -g <package>` and a symlink line to Dockerfile step 8
   - For **local packages** (in `packages/`): add COPY + `npm install -g` + symlink to Dockerfile (see step 8b)
2. **Add a flag** in `pi-sandbox` that appends the extension name to `ENABLED_EXTENSIONS`
   (e.g., `ENABLED_EXTENSIONS+=(pi-my-new-ext)`) and add the flag to the `--help` text
3. **Add a row** to the tables above
4. **Rebuild the image** (`./pi-build-sandbox`)

No entrypoint changes are needed — it generically resolves extension names from
`PI_ENABLED_EXTENSIONS` to paths in `~/.pi-sandbox/pi-extensions/`.

## Self-Modification

With `--self-modify` (or `-s`), the sandbox mounts its own source directory
read-write at `/home/<username>/.sandbox-source` and sets `SANDBOX_SELF_MODIFY=1`.
The entrypoint script then symlinks the `self-modify-sandbox` skill from the
mounted source into `~/.pi/agent/skills/`, making it available to the agent.

The skill provides:
- Awareness of all sandbox source files and their purposes
- Validation scripts (`scripts/validate.sh`) to check edits before rebuild
- Status/diff scripts to review changes
- Instructions to notify the user that a rebuild is needed on the host

The agent **cannot rebuild the Docker image** from inside the container
(Docker socket is not mounted for security). After making changes, the agent
should tell the user to run `./pi-build-sandbox` on the host.

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
./pi-sandbox --tmux

# Specify socket explicitly
./pi-sandbox --tmux /tmp/tmux-1000/default

# Combine with other flags
./pi-sandbox --tmux -w
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

## Tmux SSH Mode

With `--tmux-ssh <host>`, the sandbox enables the `tmux` tool to proxy all
commands over SSH to a remote host's tmux sessions. This is an alternative
to `--tmux` (local socket) that works when the target tmux is running on
a remote machine you can SSH into.

**How it works:**

- Sets `TMUX_SSH_HOST` env var in the container, which the `tmux` tool reads
- The tool runs `ssh <host> tmux <args>` for every action (capture-pane,
  send-keys, list-sessions, etc.)
- Uses the remote host's **default tmux socket** — no `-S` flag is sent,
  as if you SSH'd in yourself and ran `tmux a`
- SSH connections use **ControlMaster=auto** with `ControlPersist=10m` and
  `ServerAliveInterval=15`, so connections are multiplexed (low overhead)
  and self-healing (if the master dies, the next call creates a new one)

**Prerequisites:**

- `--ssh` (`-S`) must also be specified so the SSH agent is forwarded
- The remote host must have `tmux` installed and running sessions
- `~/.ssh/config` should have `StrictHostKeyChecking=accept-new` or `no`
  for the target host (since `~/.ssh` is mounted read-only, the agent
  cannot add new host keys)

```bash
# SSH tmux mode — proxy tmux tool to remote host
./pi-sandbox -S --tmux-ssh d-ubuntu-44

# Combine with other flags
./pi-sandbox -S --tmux-ssh d-ubuntu-44 -w
./pi-sandbox -S --tmux-ssh d-ubuntu-44 -s
```

**Error handling:** The tmux tool distinguishes SSH errors (connection
refused, timed out, etc.) from tmux errors, so the agent knows when a
connection issue needs to be resolved vs a tmux command failure. Transient
SSH errors (like a dropped ControlMaster) are self-healing — the next
`ssh` call automatically creates a new connection.

**`--tmux` and `--tmux-ssh` are mutually exclusive** — use one or the other.
`--tmux` for local socket access, `--tmux-ssh` for remote access over SSH.

## SSH Mode

With `--ssh` (or `-S`), the sandbox forwards the host's SSH agent and mounts
`~/.ssh` read-only, enabling the agent to connect to remote hosts via SSH.

**What gets mounted/configured:**

- The SSH agent socket directory is bind-mounted at `/ssh-agent-socket/` inside
  the container, and `SSH_AUTH_SOCK` is set to point to the socket within it.
  This allows the agent to use the host's `ssh-agent` for authentication.
- `~/.ssh` from the host is mounted read-only at `/home/<username>/.ssh`,
  providing access to `~/.ssh/config`, `~/.ssh/known_hosts`, and SSH keys
  (though key authentication goes through the forwarded agent).

**Limitations:**

- Because `~/.ssh` is mounted read-only, connecting to a host for the first time
  will fail if `StrictHostKeyChecking=yes` (the default) because the agent
  cannot write to `~/.ssh/known_hosts`. You can work around this by:
  - Pre-populating `known_hosts` on the host before launching the sandbox
  - Setting `StrictHostKeyChecking=accept-new` or `no` in `~/.ssh/config` for
    specific hosts
- `ssh-agent` must be running and `SSH_AUTH_SOCK` must be set on the host.
  The launch script validates this and exits with an error if the socket is
  missing.
- The container must have `openssh-client` installed (included in the image
  by default).

```bash
# Basic SSH forwarding
./pi-sandbox -S

# Combine with other flags
./pi-sandbox -S -w          # SSH + read-write mount
./pi-sandbox -S -s          # SSH + self-modify
./pi-sandbox -S --tmux          # SSH + local tmux debug
./pi-sandbox -S --tmux-ssh host # SSH + remote tmux over SSH
```

## Notes

- The working directory mount is **read-only by default** to prevent unintended host modifications. Use `-w` only when you explicitly want the agent to write back to the host filesystem. Use `--no-mount` (`-x`) to skip the CWD mount entirely — the agent's working directory falls back to `/home/<username>`, which is read-write (baked into the image, not a host mount).
- `$HOME/.pi` is always mounted read-write so the agent can persist config, history, and session state.
- File ownership on bind-mounted volumes is correct because `--userns=keep-id` maps the host
  UID/GID to the same values inside the container. This requires that the image was built with
  the same UID/GID as the host user running the sandbox (the `pi-build-sandbox` default).
- `/home/<username>/.pi-sandbox` is baked into the container image (not a host mount). It is writable by the agent during a session but changes are **ephemeral** — they do not persist across container restarts.
- `npm` is configured (via `NPM_CONFIG_PREFIX`) to install global packages into `/home/<username>/.pi-sandbox`. This means `npm install -g` places modules in `/home/<username>/.pi-sandbox/lib/node_modules/` and binaries in `/home/<username>/.pi-sandbox/bin/` (which is on `PATH`).
- Extensions are **disabled by default** and loaded via pi's `-ne` + `-e` mechanism. The entrypoint reads `PI_ENABLED_EXTENSIONS` (set by `pi-sandbox`) and constructs the appropriate `-e` flags. Do **not** add individual packages to `settings.json` — control extension enablement via `pi-sandbox` flags (see "Extension Opt-In System" above).

## AGENTS.md

Agents are encouraged to keep AGENTS.md up-to-date with recent changes, in
particular when new changes would break existing workflows or introduce
potential confusion for agents in the future.
