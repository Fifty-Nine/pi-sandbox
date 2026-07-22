# Agent Sandbox

A Podman-based sandbox for running `pi-coding-agent` in an isolated environment.

## Files

| File | Purpose |
|---|---|
| `Dockerfile` | Builds the `pi-sandbox` image (Debian Trixie, Python 3.14, Node 22, pi-coding-agent, acli) |
| `package.json` | Pinned npm dependencies for the image. Changing a version here invalidates the Docker build cache for the npm install layer, triggering a fresh install. |
| `pi-sandbox` | Launch script that mounts config + working directory into the container |
| `entrypoint` | Container entrypoint: sets up extension symlinks, skill symlinks, then execs CMD |
| `AGENTS.md` | This file |
| `skills/self-modify-sandbox/` | Pi skill for sandbox self-modification (loaded when `--self-modify` is active) |
| `packages/pi-send-email/` | Pi extension for sending markdown documents as HTML email via SMTP |
| `packages/pi-tmux-debug/` | Local pi package providing tmux interaction tool and debugging skill |
| `packages/pi-sub-agent/` | Local pi package providing nested sub-agent support (disabled by default, enable with `--sub-agent`) |

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
- **Languages:** Python 3.14 (via uv standalone builds), Node.js 22 (via NodeSource)
- **Tools:** `uv` (fast Python package manager by Astral), `acli` (Atlassian Command Line Interface for Jira), `pandoc` (document conversion, used by the pi-send-email extension)
- **QMK Build Dependencies:** AVR toolchain (`gcc-avr`, `avr-libc`, `binutils-avr`), ARM toolchain (`gcc-arm-none-eabi`, `binutils-arm-none-eabi`, `libnewlib-arm-none-eabi`), RISC-V toolchain (`gcc-riscv64-unknown-elf`, `binutils-riscv64-unknown-elf`, `picolibc-riscv64-unknown-elf`), flashing tools (`avrdude`, `dfu-programmer`, `dfu-util`, `teensy-loader-cli`), and supporting libraries (`libhidapi-hidraw0`, `libusb-dev`)
- **User:** Configurable at build time (defaults to the building user's UID/GID/name). Inside the container, the home directory is `/home/<username>/.pi-sandbox`. See **Build** below.
- **npm packages:** Installed via `package.json` into `/home/<username>/.pi-sandbox/npm-packages/node_modules/` (see **npm Package Management** below)
- **npm global prefix:** `/home/<username>/.pi-sandbox` (for any `npm install -g` during runtime; used by local packages like `pi-tmux-debug`)
- **Entry command:** `pi` (from `@earendil-works/pi-coding-agent`)

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
| `$HOME/.pi` | `/home/<username>/.pi` | read-write |
| `$PWD` | `/home/<username>/<relative>` | read-only (default), skipped with `--no-mount` |
| Paths from `.pimounts` | Same absolute path as host | read-only (default) or read-write (`:rw`) |
| `$HOME/.ssh` (if `--ssh`) | `/home/<username>/.ssh` | read-only |
| SSH agent socket (if `--ssh`) | `/ssh-agent-socket/<basename>` | read-write (bind mount of socket directory) |
| `$HOME/.config/acli` (if `--acli`) | `/home/<username>/.config/acli` | read-only |
| `/run/user/<uid>` (if `--acli`) | `/run/user/<uid>` | read-write (D-Bus session bus for keyring) |
| Sandbox source (if `--self-modify`) | `/home/<username>/.sandbox-source` | read-write |
| Masked directories (`.piignore` / `--mask`) | `/home/<username>/<path>` | read-only bind mount from temp dir containing `MASKED-BY-PI-SANDBOX.txt` |

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

# ACLI mode — mount ~/.config/acli read-only for Jira authentication
./pi-sandbox --acli

# Tmux debug mode — mount tmux socket + enable pi-tmux-debug extension
./pi-sandbox --tmux
./pi-sandbox --tmux /tmp/tmux-1000/default

# Disable pi-ask-user (searxng-suite still enabled)
./pi-sandbox --no-ask-user

# Docker mode — mount /var/run/docker.sock for container lifecycle management
./pi-sandbox --docker

# Skip .pimounts processing
./pi-sandbox --no-pimounts

# Pass additional pi arguments after --
./pi-sandbox -- --resume                  # pi -ne -e pi-ask-user -e searxng-suite --resume
./pi-sandbox --tmux -- --resume            # pi -ne -e pi-ask-user -e searxng-suite -e pi-tmux-debug --resume

# Override the container command entirely
./pi-sandbox -- bash
./pi-sandbox -w -- bash

# Combine flags
./pi-sandbox -s -w
./pi-sandbox -s -x
./pi-sandbox -S -w
./pi-sandbox -S --tmux
./pi-sandbox --acli -w
./pi-sandbox --acli -s

# Docker mode with other flags
./pi-sandbox --docker -w
./pi-sandbox --docker -S
./pi-sandbox --docker --acli
./pi-sandbox --docker --sub-agent

# Sub-agent mode — enable nested sub-agents
./pi-sandbox --sub-agent
./pi-sandbox --sub-agent --sub-agent-model claude-haiku-4-5
./pi-sandbox --sub-agent --sub-agent-turn-limit 50

# Combine sub-agent with other flags
./pi-sandbox --sub-agent -w
./pi-sandbox --sub-agent -S
```

## Extension Opt-In System

Sandbox extensions are **disabled by default** and must be explicitly enabled
via `pi-sandbox` flags, except for `pi-ask-user`, `searxng-suite`, and
`pi-ollama` which are enabled by default. This gives users
fine-grained control over which capabilities the agent has access to.

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
| *(default)* | `pi-ask-user`, `searxng-suite`, `pi-ollama` | Default extensions are always on unless explicitly disabled |
| `--tmux [SOCKET]` | `pi-ask-user`, `searxng-suite`, `pi-ollama`, `pi-tmux-debug` | Also mounts tmux socket |
| `--tmux-ssh HOST` | `pi-ask-user`, `searxng-suite`, `pi-ollama`, `pi-tmux-debug` | Proxies tmux over SSH |
| `--no-ask-user` | `searxng-suite`, `pi-ollama` | Disables only `pi-ask-user`; other defaults remain |
| `--docker` | *(no extension change)* | Mounts `/var/run/docker.sock` for container lifecycle management |
| `--no-searxng` | `pi-ask-user`, `pi-ollama` | Disables only `searxng-suite`; other defaults remain |
| `--no-ask-user --no-searxng` | `pi-ollama` | Disables some default extensions |
| `--sub-agent` | `pi-ask-user`, `searxng-suite`, `pi-ollama`, `pi-sub-agent` | Enables nested sub-agent support |
| `--email` | `pi-ask-user`, `searxng-suite`, `pi-ollama`, `pi-send-email` | Enables markdown-to-HTML email sending |

### Example Invocations

| `pi-sandbox` command | Actual `pi` command in container |
|---|---|
| `pi-sandbox` | `pi -ne -e .../pi-ask-user -e .../searxng-suite -e .../pi-ollama` |
| `pi-sandbox --tmux` | `pi -ne -e .../pi-ask-user -e .../searxng-suite -e .../pi-ollama -e .../pi-tmux-debug` |
| `pi-sandbox --tmux-ssh host -S` | `pi -ne -e .../pi-ask-user -e .../searxng-suite -e .../pi-ollama -e .../pi-tmux-debug` |
| `pi-sandbox --no-ask-user` | `pi -ne -e .../searxng-suite -e .../pi-ollama` |
| `pi-sandbox --docker` | `pi -ne -e .../pi-ask-user -e .../searxng-suite -e .../pi-ollama` |
| `pi-sandbox --no-searxng` | `pi -ne -e .../pi-ask-user -e .../pi-ollama` |
| `pi-sandbox --no-ask-user --no-searxng` | `pi -ne -e .../pi-ollama` |
| `pi-sandbox --sub-agent` | `pi -ne -e .../pi-ask-user -e .../searxng-suite -e .../pi-ollama -e .../pi-sub-agent` |
| `pi-sandbox --sub-agent --sub-agent-model claude-haiku-4-5` | Same as above with sub-agent model override |
| `pi-sandbox --email` | `pi -ne -e .../pi-ask-user -e .../searxng-suite -e .../pi-ollama -e .../pi-send-email` |
| `pi-sandbox -- --resume` | `pi -ne -e .../pi-ask-user -e .../searxng-suite -e .../pi-ollama --resume` |
| `pi-sandbox -- -e /my/ext` | `pi -ne -e .../pi-ask-user -e .../searxng-suite -e .../pi-ollama -e /my/ext` |
| `pi-sandbox -- bash` | `bash` (not pi) |

Current packages:

| Package | Purpose | Enabled by |
|---------|---------|------------|
| `pi-ask-user` | Interactive `ask_user` tool with searchable selection UI | default (disable with `--no-ask-user`) |
| `searxng-suite` | SearXNG web search & fetch tool for the agent (`@blazer2k/searxng-suite` npm package) | default (disable with `--no-searxng`) |
| `pi-ollama` | Ollama provider (local + cloud) for pi (`@0xkobold/pi-ollama` npm package) | default (always on) |
| `pi-tmux-debug` | Tmux interaction tool (`capture-pane`, `send-keys`, etc.) + `tmux-debug` skill | `--tmux` or `--tmux-ssh` |
| `pi-sub-agent` | Nested sub-agent support (`spawn_agent`, `prompt_agent`, etc.) | `--sub-agent` |
| `pi-send-email` | Send markdown documents as HTML email via SMTP with TLS (`send_markdown_email` tool) | `--email` |

### Send Markdown Email

The sandbox includes the `pi-send-email` extension, which registers a
`send_markdown_email` tool callable by the agent. It uses `pandoc` (installed
system-wide) for markdown-to-HTML conversion and `nodemailer` for SMTP with
STARTTLS.

**Enable with:** `--email` flag

**SMTP relay:** `mail.home.trprince.com:465` (SMTPS / implicit TLS)

**Credentials:** Stored in `~/.pi/agent/auth.json` under the `"smtp"` key:

```json
{
  "smtp": {
    "host": "mail.home.trprince.com",
    "port": 465,
    "username": "notifications",
    "password": "your-password",
    "from": "notifications@home.trprince.com"
  }
}
```

The `from` field is optional; if omitted, the SMTP username is used as the
sender address (which may not be a valid email).
}
```

**Tool parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `to` | Yes | Recipient email address |
| `subject` | Yes | Email subject line |
| `file` | Yes | Path to the markdown file to send |
| `cc` | No | CC recipient email address |
| `from` | No | From address (defaults to SMTP username) |

**Host-gateway handling:** If `mail.home.trprince.com` resolves to a local IP,
the launch script automatically sets `PI_MAIL_HOST_GATEWAY=1`, and the entrypoint
patches `/etc/hosts` to map the hostname to `host.containers.internal`.

### SearXNG URL

The `searxng-suite` extension reads the `SEARXNG_URL` environment variable to find
the SearXNG instance. The launch script forwards the host's `SEARXNG_URL` into
the container. If not set, the extension defaults to `http://localhost:8888`.

```bash
# Set on the host before launching:
export SEARXNG_URL=https://searxng.home.trprince.com
./pi-sandbox
```

### Atlassian CLI (`acli`)

The Atlassian CLI (`acli`) is installed system-wide via its official APT repository. It is always available inside the container (no extension flag needed).

`acli` enables the `cmpcpp-jira-search` skill to search and inspect Jira workitems. Use the `--acli` flag to mount your acli config and keyring access into the container.

`acli` stores authentication tokens (both OAuth and API token) in the OS keyring (D-Bus Secret Service), not in config files on disk. The `--acli` flag forwards the host's D-Bus session bus into the container so `acli` can retrieve tokens from the keyring. Both OAuth and API token auth work inside the container with `--acli`.

To set up authentication on the host (one-time):

```bash
# OAuth (browser-based, recommended):
acli jira auth login --web

# API token (for headless/CI environments):
echo "$API_TOKEN" | acli jira auth login --email you@example.com --site yourorg.atlassian.net --token
```

```bash
# Verify acli is available
acli --version

# Search Jira (requires --acli flag)
pi-sandbox --acli
# Inside the container:
acli jira workitem search --jql 'project = cmpcpp and status = New' --json
```

## Docker Mode

With `--docker`, the sandbox enables the agent to manage Docker containers on the
host. This is useful for workflows that involve building, running, or inspecting
containers.

### How It Works

Rootless Podman always uses a user namespace, which remaps UIDs and GIDs. The
Docker socket at `/var/run/docker.sock` is owned by `root:docker` (UID 0, GID 994)
on the host — IDs that are not mapped into the container's user namespace. This
means the socket appears as owned by `nobody:nogroup` (UID/GID 65534) inside the
container and is inaccessible, even with `--privileged`.

To work around this, the launch script runs `socat` on the **host** to create a
new Unix socket owned by the user (whose UID/GID **are** mapped into the
container). `socat` proxies between this user-owned socket and the real Docker
socket. The proxy socket is created in a temporary directory with mode 0600
(user-only access), so there is no privilege escalation risk.

```
Host:  /var/run/docker.sock  (root:docker, mode 660)
          |
          |  socat proxy (runs as user, who is in docker group)
          v
       /tmp/pi-sandbox-docker-XXXXXX/docker.sock  (user:user, mode 600)
          |
          |  bind-mounted into container
          v
Container:  DOCKER_HOST=unix:///tmp/pi-sandbox-docker-XXXXXX/docker.sock
```

Lifecycle: the temp directory and `socat` process are created before the
container starts and cleaned up after it exits. Each sandbox session gets its
own proxy, so multiple sandboxes work independently.

### What Gets Installed

The container image includes:
- **`docker-ce-cli`** — The Docker CLI (`docker` command), installed from Docker's official APT repository
- **`docker-compose-plugin`** — Docker Compose v2 plugin (`docker compose` subcommand), installed from Docker's official APT repository

All are always present in the image, but the proxy is only set up when `--docker`
is passed.

### Security Implications

Using `--docker` gives the agent **root-equivalent access** to the host's Docker
daemon. The agent can:
- Start, stop, and remove any container
- Build and push images
- Access volumes and networks
- Execute commands inside any container

This is equivalent to being a member of the `docker` group on the host. Only use
`--docker` in trusted environments where you are comfortable with the agent having
full control over the Docker daemon.

The proxy socket is created with mode 0600 and is only accessible by the user who
launched the sandbox. No TCP port is opened, so there is no network-accessible
attack surface.

### Usage

```bash
# Enable Docker access
./pi-sandbox --docker

# Combine with other flags
./pi-sandbox --docker -w
./pi-sandbox --docker -S
./pi-sandbox --docker --acli
./pi-sandbox --docker --sub-agent
```

### Prerequisites

- The Docker daemon must be running on the host (`dockerd` or Docker Desktop)
- The socket must exist at `/var/run/docker.sock` (the default location)
- `socat` must be installed on the host (`sudo apt install socat`)
- The user must be a member of the `docker` group on the host

### Example Invocations

| `pi-sandbox` command | Actual `pi` command in container |
|---|---|
| `pi-sandbox --docker` | `pi -ne -e .../pi-ask-user -e .../searxng-suite -e .../pi-ollama` |

### Adding a New Extension

To add a new pi package to the sandbox:

1. **Install the package** in the Dockerfile:
   - For **npm packages**: add the package with a pinned version to `package.json` `dependencies`, and add a symlink line to Dockerfile step 8
   - For **local packages** (in `packages/`): add COPY + `npm install -g` + symlink to Dockerfile (see step 8b)
2. **Add a flag** in `pi-sandbox` that appends the extension name to `ENABLED_EXTENSIONS`
   (e.g., `ENABLED_EXTENSIONS+=(pi-my-new-ext)`) and add the flag to the `--help` text
3. **Add a row** to the tables above
4. **Rebuild the image** (`./pi-build-sandbox`)

No entrypoint changes are needed — it generically resolves extension names from
`PI_ENABLED_EXTENSIONS` to paths in `~/.pi-sandbox/pi-extensions/`.

### Updating npm Package Versions

npm packages are installed from `package.json` (not `npm install -g`). Pin exact versions
in `package.json` dependencies — when a version changes, the `COPY package.json` Dockerfile
step produces a different layer, which invalidates the cache for the `npm install` step
and all subsequent layers. This is the standard Docker cache-busting pattern.

To update a package:
1. Change the version in `package.json`
2. Rebuild the image (`./pi-build-sandbox`)

Only the npm install layer (and layers after it) are rebuilt — earlier layers (apt, pyenv,
Node.js, etc.) remain cached.

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

## Sub-Agent Mode

With `--sub-agent`, the sandbox enables the `pi-sub-agent` extension, which lets the
supervisor agent spawn persistent nested sub-agents with isolated context windows.

### How It Works

The extension registers four tools:

| Tool | Purpose |
|------|---------|
| `spawn_agent` | Create a new sub-agent session with specified tools and system prompt |
| `prompt_agent` | Send a prompt to an existing sub-agent and wait for its response |
| `list_agents` | List all active sub-agent sessions |
| `destroy_agent` | Destroy a sub-agent session and free resources |

Each sub-agent is an in-process pi session created via the pi SDK (`createAgentSession()`).
Sub-agents use `SessionManager.inMemory()` — their conversations are ephemeral and do
not persist to disk.

### Context Retention

Unlike one-shot delegation tools, sub-agents **retain context across multiple
`prompt_agent` calls**. The supervisor can prompt the same agent repeatedly, and
each call builds on the previous conversation history.

```
spawn_agent("reviewer", tools=["read","grep"], system_prompt="You review code.")
  → Agent created, context empty

prompt_agent("reviewer", "Review auth.ts")
  → Sub-agent reads auth.ts, returns review. Context now has 1 exchange.

prompt_agent("reviewer", "Now review db.ts")
  → Sub-agent remembers the auth.ts review, reviews db.ts in context.

destroy_agent("reviewer")
  → Session disposed.
```

### Tool Isolation

The supervisor specifies which tools the sub-agent can use. The sub-agent **cannot**
call `spawn_agent`, `prompt_agent`, `list_agents`, or `destroy_agent` — recursive
nesting is prevented by the extension.

### Streaming Output

The sub-agent's output streams to the TUI in real-time for the user to observe.
However, only the **final response** is returned to the supervisor's context —
intermediate thinking and tool calls do not bloat the supervisor's conversation history.

### Turn Budget

To prevent excessive token burn, sub-agents operate under a **per-response budget**
based on `prompt_agent` calls. Each time the supervisor calls `prompt_agent`, that
counts as 1 toward the budget — regardless of how many internal turns the sub-agent
uses. When the budget is exhausted:

1. The `prompt_agent` call is blocked with a budget-exhausted message
2. Any subsequent `spawn_agent` or `prompt_agent` calls in the same supervisor
   response are **blocked**
3. The budget resets when the user sends a new message

This prevents the supervisor from bypassing the limit by spawning new agents or
re-prompting the same agent, while allowing sub-agents to complete multi-step
tasks without being interrupted.

### Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--sub-agent` | disabled | Enable the pi-sub-agent extension |
| `--sub-agent-model NAME` | (same as supervisor) | Model for sub-agents, e.g. `claude-haiku-4-5` |
| `--sub-agent-turn-limit N` | 30 | Max sub-agent turns per supervisor response. `-1` = unlimited |

### Usage

```bash
# Enable sub-agent support with defaults (same model as supervisor, 30-turn limit)
./pi-sandbox --sub-agent

# Use a cheaper model for sub-agents with a higher turn limit
./pi-sandbox --sub-agent --sub-agent-model claude-haiku-4-5 --sub-agent-turn-limit 50

# Unlimited turns (use with caution)
./pi-sandbox --sub-agent --sub-agent-turn-limit -1

# Combine with other flags
./pi-sandbox --sub-agent -w
./pi-sandbox --sub-agent --sub-agent-model claude-sonnet-4-6
```

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

## ACLI Mode

With `--acli`, the sandbox mounts `~/.config/acli/` read-only from the host
and forwards the D-Bus session bus into the container, enabling `acli` (the
Atlassian Command Line Interface) to authenticate with Jira. This is required
for the `cmpcpp-jira-search` skill and any other `acli`-based Jira workflows.

**What gets mounted/configured:**

- `$HOME/.config/acli/` from the host is mounted read-only at
  `/home/<username>/.config/acli/` inside the container. This directory
  contains the `acli` configuration and profile metadata.
- The host's `/run/user/<uid>` directory is bind-mounted into the container
  at the same path, and `DBUS_SESSION_BUS_ADDRESS` is set to point to the D-Bus
  socket. This gives `acli` access to the host's Secret Service keyring
  (gnome-keyring / kwallet), where auth tokens are stored regardless of
  authentication type.

**Prerequisites:**

- You must authenticate with `acli` on the host first. Both OAuth (`acli auth login --web`)
  and API token (`echo "$TOKEN" | acli jira auth login --site ... --email ... --token`)
  methods work, because `--acli` forwards the keyring via D-Bus.
- The launch script validates that `~/.config/acli/` exists and exits with an
  error if it is missing.
- `acli` is installed system-wide in the container image — no additional
  setup is needed inside the container.

> **Why D-Bus forwarding?** `acli` stores auth tokens (both OAuth and API token)
> in the OS keyring via D-Bus Secret Service, not in config files. The config
> files in `~/.config/acli/` only contain profile metadata (site, email,
> auth_type). Without D-Bus access, `acli` cannot retrieve the actual credentials
> and will report "unauthorized". The `--acli` flag forwards the host's D-Bus
> session bus so the container can reach the keyring daemon running on the host.

```bash
# Authenticate on the host first (one-time)
acli auth login --web                                    # OAuth (browser-based)
echo "$API_TOKEN" | acli jira auth login --site ... --email ... --token  # API token

# Then launch the sandbox with --acli
./pi-sandbox --acli

# Combine with other flags
./pi-sandbox --acli -w       # ACLI + read-write mount
./pi-sandbox --acli -s       # ACLI + self-modify
./pi-sandbox --acli -S       # ACLI + SSH
```

## Directory Masking

The sandbox supports **masking** directories so they appear empty inside the
container. This is useful for hiding sensitive subdirectories (e.g.
`secrets/`, `.env/`, `credentials/`) from the agent without affecting the
host filesystem.

### How It Works

Masking works by overlaying a **read-only bind mount** from a temporary empty
directory on top of the target directory inside the container. The container's
mount namespace is separate from the host — the overlay only exists inside the
container and has **zero impact on the host filesystem**. No files are copied,
chmod'd, or modified on the host.

Masked directories appear as empty, read-only directories to the agent,
except for a `MASKED-BY-PI-SANDBOX.txt` marker file that explains why the
directory is hidden. This makes masking discoverable — an agent listing the
directory will see the marker instead of a confusingly empty directory.

> **Note:** We use bind mounts (not `--tmpfs`) because Podman processes
> `--tmpfs` mounts before `--mount type=bind` mounts regardless of command-line
> order. This means a tmpfs overlay on a subdirectory of the CWD bind mount
> would be silently overridden. Bind mounts are applied in order, so the mask
> overlay correctly supersedes the CWD mount.

### Sources of Mask Paths

1. **`.piignore` file** (automatic): If a `.piignore` file exists in the
   working directory, it is read automatically. Each non-comment,
   non-blank line is a path to mask (relative to the working directory).
   Glob patterns (`*` and `**`) are expanded against the host filesystem.

2. **`--mask PATH` flag** (explicit): Masks an additional directory.
   `PATH` is relative to the working directory (or absolute on the host).
   May be specified multiple times.

3. **`--no-piignore` flag**: Skips `.piignore` processing even if the file
   exists. Explicit `--mask` paths are still applied.

### `.piignore` Format

```
# Comment lines start with #
secrets/
credentials/
**/node_modules/
.env/
```

- One path per line, relative to the working directory
- Blank lines and `#` comments are ignored
- Glob patterns (`*` and `**`) are expanded against the host filesystem
- Only **directories** are masked (individual files cannot be masked)
- Paths ending with `/` or not are both accepted

### Usage

```bash
# Auto-mask directories from .piignore
./pi-sandbox

# Explicitly mask a directory
./pi-sandbox --mask secrets/
./pi-sandbox --mask secrets/ --mask .env/

# Skip .piignore processing
./pi-sandbox --no-piignore

# Combine with other flags
./pi-sandbox -w --mask secrets/
./pi-sandbox --no-piignore --mask secrets/
```

### Implementation Details

- Mask paths are translated from host paths to container paths using the same
  `$HOME` → `/home/<username>` mapping as the CWD mount
- Each mask path gets a `--mount type=bind,source=<tmpdir>,target=<path>,readonly`
  in the container, where `<tmpdir>` is a temporary empty directory created by
  the launch script and cleaned up after the container exits
- The temporary directory contains a `MASKED-BY-PI-SANDBOX.txt` marker file
  explaining that the directory has been masked, so agents encountering an
  unexpectedly empty directory can discover the reason
- Mask paths are deduplicated (multiple `--mask` flags or `.piignore` entries
  that resolve to the same path are merged)
- Masking is skipped when `--no-mount` is used (no CWD mount = nothing to
  mask under)

## Extra Mounts (.pimounts)

The sandbox supports **extra bind mounts** via a `.pimounts` file in the working
directory. This is useful for making symlink targets accessible inside the
container — symlinks in the CWD that point to paths outside the CWD will
resolve correctly if those paths are mounted.

### How It Works

When a `.pimounts` file exists in the working directory, the launch script
reads it and adds bind mounts for each listed path. The path is mounted at the
**same absolute path** inside the container — Podman auto-creates parent
directories for the mount target, so symlinks with absolute targets resolve
correctly.

For example, if your project has:

```
/home/user/ck3-data/
├── game  -> /home/user/.steam/steam/steamapps/common/Crusader Kings III/
├── saves -> /home/user/.steam/steam/userdata/6233966/1158310/remote/save games/
└── .pimounts
```

And `.pimounts` contains:

```
/home/user/.steam/steam/steamapps/common/Crusader Kings III/
/home/user/.steam/steam/userdata/6233966/1158310/remote/save games/:rw
```

Then inside the container, both `/home/user/.steam/...` paths are mounted at
their original locations, and the symlinks `game` and `saves` resolve correctly.

### `.pimounts` Format

```
# Comment lines start with #
/home/user/.steam/steam/steamapps/common/Crusader Kings III/
/home/user/.steam/steam/userdata/6233966/1158310/remote/save games/:rw
```

- One entry per line
- Blank lines and `#` comments are ignored
- Each entry is a host path, optionally followed by `:ro` (read-only, default)
  or `:rw` (read-write)
- Relative paths are resolved against the working directory
- Only **directories** can be mounted (individual files cannot)
- The source path must exist on the host; missing paths are skipped with a
  warning

### Mount Mode

| Suffix | Mode | Description |
|--------|------|-------------|
| *(none)* | read-only | Default. The mounted directory is read-only inside the container. |
| `:ro` | read-only | Explicit read-only (same as default). |
| `:rw` | read-write | The mounted directory is writable inside the container. |

### Security: Read-Only `.pimounts`

The `.pimounts` file itself is **mounted read-only** inside the container by
default, even when the CWD is mounted read-write (`-w`). This prevents a
compromised or misbehaving agent from modifying `.pimounts` to mount additional
host directories (a form of privilege escalation).

This works by adding a file-level read-only bind mount of `.pimounts` on top
of the directory-level CWD mount. Since bind mounts are applied in command-line
order, the file-level overlay overrides the directory mount for that specific
file.

Use `--pimounts-rw` to opt into read-write access (e.g., when you explicitly
want the agent to update `.pimounts`). Agents should write proposed changes to
`.pimounts.new` by default for your review, rather than modifying `.pimounts`
directly.

### Usage

```bash
# .pimounts is read automatically if present
./pi-sandbox

# Skip .pimounts processing
./pi-sandbox --no-pimounts

# Mount .pimounts read-write (opt-in)
./pi-sandbox --pimounts-rw

# Combine with read-write CWD mount
./pi-sandbox -w

# Combine with other flags
./pi-sandbox -w --no-pimounts
./pi-sandbox -w --pimounts-rw
./pi-sandbox -s -w
```

### Implementation Details

- `.pimounts` is only processed when the CWD is mounted (skipped with
  `--no-mount`)
- Each entry becomes a `--mount type=bind,source=<path>,target=<path>[,readonly]`
  in the container
- Paths are normalized (`.` and `..` resolved) before mounting
- Missing source directories produce a warning and are skipped (no hard error)
- The `--no-pimounts` flag disables `.pimounts` processing entirely
- The `.pimounts` file is mounted read-only by default (overridden with
  `--pimounts-rw`) to prevent agent tampering with mount configuration

## Notes

- The working directory mount is **read-only by default** to prevent unintended host modifications. Use `-w` only when you explicitly want the agent to write back to the host filesystem. Use `--no-mount` (`-x`) to skip the CWD mount entirely — the agent's working directory falls back to `/home/<username>`, which is read-write (baked into the image, not a host mount).
- `$HOME/.pi` is always mounted read-write so the agent can persist config, history, and session state.
- File ownership on bind-mounted volumes is correct because `--userns=keep-id` maps the host
  UID/GID to the same values inside the container. This requires that the image was built with
  the same UID/GID as the host user running the sandbox (the `pi-build-sandbox` default).
- `/home/<username>/.pi-sandbox` is baked into the container image (not a host mount). It is writable by the agent during a session but changes are **ephemeral** — they do not persist across container restarts.
- npm packages are installed via `package.json` into `/home/<username>/.pi-sandbox/npm-packages/node_modules/`. Binaries from those packages (e.g., `pi`) are available via `node_modules/.bin/` on `PATH`. The `NPM_CONFIG_PREFIX` env var is still set for `npm install -g` (used by local packages like `pi-tmux-debug` and any runtime installs), which places global modules in `/home/<username>/.pi-sandbox/lib/node_modules/` and binaries in `/home/<username>/.pi-sandbox/bin/` (also on `PATH`).
- Extensions are **disabled by default** and loaded via pi's `-ne` + `-e` mechanism. The entrypoint reads `PI_ENABLED_EXTENSIONS` (set by `pi-sandbox`) and constructs the appropriate `-e` flags. Do **not** add individual packages to `settings.json` — control extension enablement via `pi-sandbox` flags (see "Extension Opt-In System" above).

## AGENTS.md

Agents are encouraged to keep AGENTS.md up-to-date with recent changes, in
particular when new changes would break existing workflows or introduce
potential confusion for agents in the future.
