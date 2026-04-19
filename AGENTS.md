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
- **npm global prefix:** `/home/agent/.agent-sandbox` (global modules installed there)
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

`/home/agent/.agent-sandbox` is **not** mounted from the host. It is baked into the Docker image and is container-ephemeral: the agent can write to it freely during a session, but changes do not persist across container restarts.

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

## Pi Package Extensions

Pi packages (npm packages with pi extensions/skills/prompts) are installed in
the Dockerfile and discovered at runtime via an entrypoint script:

1. **Install via npm** in the Dockerfile (step 8)
2. **Symlink** into `/home/agent/.agent-sandbox/pi-extensions/` (Dockerfile step 8)
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

**To add a new pi package:**
1. Add `npm install -g <package>` and a symlink line to Dockerfile step 8
2. Add a row to the table above
3. Rebuild the image

## Notes

- The working directory mount is **read-only by default** to prevent unintended host modifications. Use `-w` only when you explicitly want the agent to write back to the host filesystem.
- `$HOME/.pi` is always mounted read-write so the agent can persist config, history, and session state.
- `/home/agent/.agent-sandbox` is baked into the Docker image (not a host mount). It is writable by the agent during a session but changes are **ephemeral** — they do not persist across container restarts.
- `npm` is configured (via `NPM_CONFIG_PREFIX`) to install global packages into `/home/agent/.agent-sandbox`. This means `npm install -g` places modules in `/home/agent/.agent-sandbox/lib/node_modules/` and binaries in `/home/agent/.agent-sandbox/bin/` (which is on `PATH`).
- Pi packages are discovered via symlinks in `~/.pi/agent/extensions/` created by the entrypoint script at startup. The entrypoint reads from the `pi-extensions/` symlink farm baked into the image. Do **not** add individual packages to `settings.json` — add them to the Dockerfile symlink farm instead (see "Pi Package Extensions" above).

## AGENTS.md

Agents are encouraged to keep AGENTS.md up-to-date with recent changes, in
particular when new changes would break existing workflows or introduce
potential confusion for agents in the future.
