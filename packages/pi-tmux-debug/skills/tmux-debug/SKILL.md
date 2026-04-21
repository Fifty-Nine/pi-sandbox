---
name: tmux-debug
description: Debug issues in a user-provided tmux session by capturing pane output and sending keystrokes. Use when the user wants you to interact with a running tmux session.
---

# Tmux Debug

This skill lets you debug issues in a tmux session by capturing what's on screen and sending keystrokes. You interact with the target system exclusively through the tmux tool — you can see terminal output and type commands, just like sitting at the keyboard.

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