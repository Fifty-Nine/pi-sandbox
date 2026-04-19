# Agent Sandbox

A Docker-based sandbox for running `pi-coding-agent` in an isolated environment.

## Files

| File | Purpose |
|---|---|
| `Dockerfile` | Builds the `agent-sandbox` image (Debian Trixie, pyenv/Python 3.13, Node 22, pi-coding-agent) |
| `sandbox` | Launch script that mounts config + working directory into the container |
| `AGENTS.md` | This file |

## Docker Image (`agent-sandbox`)

- **Base:** `debian:trixie-slim`
- **Languages:** Python 3.13 (via pyenv), Node.js 22 (via NodeSource)
- **User:** `agent` (UID 1026, GID 1000) with passwordless sudo
- **Entry command:** `pi` (from `@mariozechner/pi-coding-agent`)

### Build

```bash
docker build -t agent-sandbox .
```

## Launch Script (`sandbox`)

Runs the container with bind mounts so the agent sees the host project directory and your pi configuration.

### Mounts

| Host path | Container path | Mode |
|---|---|---|
| `$HOME/.pi` | `/home/agent/.pi` | read-write |
| `$PWD` | `/home/agent/<relative>` | read-only (default) |

`$PWD` is remapped by replacing the `$HOME` prefix with `/home/agent`. For example, if you are in `/home/princet/my-project`, it mounts at `/home/agent/my-project`, and the agent's working directory is set there.

### Usage

```bash
# Read-only mount (default) — agent can read but not modify your files
./sandbox

# Read-write mount — agent can modify files in the working directory
./sandbox -w
./sandbox --read-write

# Override the container command
./sandbox -- bash
./sandbox -w -- bash
```

## Notes

- The working directory mount is **read-only by default** to prevent unintended host modifications. Use `-w` only when you explicitly want the agent to write back to the host filesystem.
- `$HOME/.pi` is always mounted read-write so the agent can persist config, history, and session state.

## AGENTS.md

Agents are encouraged to keep AGENTS.md up-to-date with recent changes, in
particular when new changes would break existing workflows or introduce
potential confusion for agents in the future.
