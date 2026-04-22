---
name: tmux-debug
description: Debug issues in a tmux session by capturing pane output and sending keystrokes. Works with local tmux sessions (via socket mount) or remote tmux sessions (via SSH). Use when the user wants you to interact with a running tmux session.
---

# Tmux Debug

This skill lets you debug issues in a tmux session by capturing what's on screen and sending keystrokes. You interact with the target system exclusively through the tmux tool — you can see terminal output and type commands, just like sitting at the keyboard.

## Modes

The tmux tool supports two modes, configured by the sandbox launch script:

### Local Mode (`--tmux`)
Interacts with a local tmux session via its Unix socket. The socket is mounted into the container and `TMUX_SOCKET_PATH` is set.

### SSH Mode (`--tmux-ssh HOST`)
Proxies all tmux commands over SSH to a remote host. Uses the remote host's default tmux socket (as if you SSH'd in and ran `tmux a`). SSH connections use `ControlMaster=auto` for self-healing multiplexing — no manual setup is needed, and if a connection drops, the next command automatically re-establishes it.

Requires `--ssh` for SSH agent forwarding.

```bash
# Example: SSH to d-ubuntu-44 with SSH auth
./pi-sandbox -S --tmux-ssh d-ubuntu-44
```

**SSH error handling:** If an SSH connection error occurs, the tool reports it as an `SSH error:` (vs `tmux error:`). The `waitForCompletion` polling loop automatically retries on transient SSH errors. With `ControlMaster=auto`, transient failures self-heal — the next SSH call creates a fresh connection.

## Getting Started

1. **Discover sessions**: `tmux` with action `list_sessions`
2. **Capture the current state**: `tmux` with action `capture_pane`
3. **Iterate**: send commands, observe output, form hypotheses, test

## Target Format

The `target` parameter uses tmux's standard format:
- `session_name` — target a session (uses active window/pane within)
- `session_name:window_index` — target a specific window
- `session_name:window_index.pane_index` — target a specific pane
- Omit to use the active pane of the current session

## Workflow

### 1. Understand the Current State

Always start by capturing the pane to see what's happening:

```
action: capture_pane
target: mysession
```

### 2. Run Commands with Wait

**Use `wait: true` on `send_keys`** to automatically wait for command completion instead of manually polling with `capture_pane`. The tool will:
**Special Character Escaping**: When sending keys that include backslashes (e.g., escaping a semicolon for `find -exec`), you must use **double-backslashes** (`\\`) to ensure the backslash is delivered as a literal character to the shell.
Example: To send `find . -exec echo {} \;`, use `keys: "find . -exec echo {} \\;"`.

1. Send the keys
2. Poll the pane until output stabilizes (content unchanged for 1 second)
3. Return the captured pane content showing the command result

```
action: send_keys
keys: "ls -la"
enter: true
wait: true
```

This returns the pane content directly — no need for a separate `capture_pane` call.

**Default timeout is 30 seconds.** Override for long-running commands:

```
action: send_keys
keys: "npm test"
enter: true
wait: true
wait_timeout: 120
```

**When a command times out**, the tool returns whatever output is visible so far with a note that the command may still be running. Send `C-c` to interrupt, then use `wait: true` again to wait for the prompt to return.

**Use `wait: true` when sending `C-c`** to wait for the interrupted process to return to the shell:

```
action: send_keys
keys: "C-c"
wait: true
```

### 3. Send Control Sequences

Common tmux key names for `send_keys`:

| Key name | Effect |
|----------|--------|
| `C-c` | Interrupt (Ctrl+C) |
| `C-d` | End of input / exit (Ctrl+D) |
| `C-z` | Suspend (Ctrl+Z) |
| `C-l` | Clear screen (Ctrl+L) |
| `Escape` | Escape key |
| `Enter` | Enter key (use without `keys` for just Enter) |
| `Up` / `Down` | Arrow keys (history, navigation) |
| `Left` / `Right` | Arrow keys |
| `Home` / `End` | Home / End |
| `PgUp` / `PgDn` | Page Up / Page Down |
| `Tab` | Tab key |
| `Backspace` | Backspace |
| `C-a` through `C-z` | Ctrl+letter combinations |
| `M-a` through `M-z` | Alt/Meta+letter combinations |

Example — interrupt a running process and wait for the prompt:

```
action: send_keys
keys: "C-c"
wait: true
```

Example — quit a pager and wait for the shell:

```
action: send_keys
keys: "q"
wait: true
```

### 4. Send Without Waiting

Use `wait: false` (or omit `wait`) when you don't need to observe the result immediately — e.g., typing into an editor, navigating a menu, or when you want to capture the pane separately with `scrollback`.

### 5. Access Scrollback

When output has scrolled past the visible area:

```
action: capture_pane
scrollback: 200
```

### 6. Navigate Multi-Pane Sessions

```
action: list_panes
target: mysession
```

Then target a specific pane:

```
action: capture_pane
target: "mysession:0.1"
```

## Debugging Methodology

1. **Observe before acting** — Always capture the pane before sending keys. Don't send commands blindly.
2. **Use `wait: true` for commands** — Let the tool handle waiting instead of manual polling. This is more efficient and less error-prone.
3. **One change at a time** — Send one command, observe the result, then decide next steps.
4. **Use scrollback** — When output scrolls off screen, use `scrollback` to capture history.
5. **Handle interactive prompts** — If the terminal is waiting for input (password, y/n confirmation, editor), send exactly the needed input.
6. **Interrupt when stuck** — If something is hung or taking too long, send `C-c` (with `wait: true` to confirm the prompt returns).
7. **Check exit codes** — After a command completes, look for error messages or non-zero exit codes in the output.
8. **Explore incrementally** — Start with broad commands (`ps aux`, `dmesg`, `journalctl`), then narrow down based on what you find.

## Common Patterns

### Run a command and see the result

```
action: send_keys
keys: "ls -la"
enter: true
wait: true
```

### Check what's running

```
action: send_keys
keys: "ps aux"
enter: true
wait: true
```

### Read a log file

```
action: send_keys
keys: "tail -100 /var/log/syslog"
enter: true
wait: true
```

### Check network connectivity

```
action: send_keys
keys: "ip addr show"
enter: true
wait: true
```

### Inspect a service

```
action: send_keys
keys: "systemctl status nginx"
enter: true
wait: true
```

### Interrupt and return to prompt

```
action: send_keys
keys: "C-c"
wait: true
```

### Exit a pager

```
action: send_keys
keys: "q"
wait: true
```

### Handle SSH connection errors (SSH mode only)

If you see `SSH error:` in the output, the connection to the remote host may have dropped. With `ControlMaster=auto`, simply retrying the same command usually works — a fresh connection is established automatically. For persistent failures, check that the remote host is reachable and SSH auth is working.
