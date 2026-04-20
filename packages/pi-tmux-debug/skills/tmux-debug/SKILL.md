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

### 2. Send Commands

To run a command in the pane:

```
action: send_keys
keys: "ls -la"
enter: true
```

### 3. Observe Results

After sending keys, capture the pane again to see the result. Long-running commands may require multiple captures as output appears.

### 4. Send Control Sequences

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

Example — interrupt a running process:

```
action: send_keys
keys: "C-c"
```

Example — just press Enter (e.g., to accept a default prompt):

```
action: send_keys
keys: "Enter"
```

### 5. Access Scrollback

When output has scrolled past the visible area:

```
action: capture_pane
scrollback: 200
```

This captures the visible content plus up to 200 lines of history.

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
2. **One change at a time** — Send one command, observe the result, then decide next steps.
3. **Use scrollback** — When output scrolls off screen, use `scrollback` to capture history.
4. **Handle interactive prompts** — If the terminal is waiting for input (password, y/n confirmation, editor), send exactly the needed input.
5. **Interrupt when stuck** — If something is hung or taking too long, send `C-c` to interrupt.
6. **Check exit codes** — After running a command, capture the pane and look for error messages or non-zero exit codes in the prompt.
7. **Explore incrementally** — Start with broad commands (`ps aux`, `dmesg`, `journalctl`), then narrow down based on what you find.

## Common Patterns

### Check what's running

```
action: send_keys
keys: "ps aux"
enter: true
```

### Read a log file

```
action: send_keys
keys: "tail -100 /var/log/syslog"
enter: true
```

### Check network connectivity

```
action: send_keys
keys: "ip addr show"
enter: true
```

### Inspect a service

```
action: send_keys
keys: "systemctl status nginx"
enter: true
```

### Exit a pager (less, man, etc.)

```
action: send_keys
keys: "q"
```