#!/bin/bash
# Show changes to sandbox source files vs the git HEAD.
set -e
cd /home/agent/.sandbox-source
if [[ -d .git ]]; then
    git diff --stat HEAD
    echo ""
    echo "---"
    git diff HEAD
else
    echo "Not a git repository — cannot diff."
    exit 1
fi