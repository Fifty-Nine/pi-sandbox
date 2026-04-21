FROM debian:trixie-slim

# Avoid interactive prompts during install
ENV DEBIAN_FRONTEND=noninteractive

# -------------------------------------------------------------------
# Build arguments: customizable sandbox user (defaults match old behavior)
# -------------------------------------------------------------------
ARG SANDBOX_UID=1026
ARG SANDBOX_GID=1000
ARG SANDBOX_USER=agent
ARG SANDBOX_GROUP=agent

# Expose the username as a Docker label so the launch script can detect it
LABEL sandbox.user=${SANDBOX_USER}

# -------------------------------------------------------------------
# 1. Base packages + sudo (needed for passwordless sudo later)
# -------------------------------------------------------------------
RUN find /etc/apt/sources.list.d -type f -exec sed -i 's/Types: deb$/Types: deb deb-src/' {} +
RUN apt-get update && apt-get install -y --no-install-recommends \
        git \
        build-essential \
        sudo \
        curl \
        ca-certificates \
        libssl-dev \
        zlib1g-dev \
        libbz2-dev \
        libreadline-dev \
        libsqlite3-dev \
        libncursesw5-dev \
        xz-utils \
        tk-dev \
        libxml2-dev \
        libxmlsec1-dev \
        libffi-dev \
        liblzma-dev \
        libevent-dev \
        openssh-client \
    && apt-get build-dep -y tmux \
    && rm -rf /var/lib/apt/lists/*

# -------------------------------------------------------------------
# 1b. Build tmux from source (Debian has 3.5a which is incompatible
#     with tmux 3.6+ servers due to protocol changes)
# -------------------------------------------------------------------
ARG TMUX_VERSION=3.6a
RUN cd /tmp \
    && curl -fsSL "https://github.com/tmux/tmux/releases/download/${TMUX_VERSION}/tmux-${TMUX_VERSION}.tar.gz" | tar xz \
    && cd "tmux-${TMUX_VERSION}" \
    && ./configure \
    && make -j"$(nproc)" \
    && make install \
    && cd / \
    && rm -rf /tmp/tmux-${TMUX_VERSION}

# -------------------------------------------------------------------
# 2. pyenv + Python (set as default)
# -------------------------------------------------------------------
ARG PYTHON_VERSION=3.13
ENV PYENV_ROOT=/opt/pyenv
ENV PATH="${PYENV_ROOT}/shims:${PYENV_ROOT}/bin:${PATH}"

RUN git clone https://github.com/pyenv/pyenv.git "${PYENV_ROOT}" \
    && pyenv install ${PYTHON_VERSION} \
    && pyenv global ${PYTHON_VERSION}

# -------------------------------------------------------------------
# 3. Node.js (modern) from NodeSource
# -------------------------------------------------------------------
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# -------------------------------------------------------------------
# 4. Create sandbox user and group (configurable via build args)
# -------------------------------------------------------------------
RUN groupadd --gid ${SANDBOX_GID} ${SANDBOX_GROUP} \
    && useradd \
        --uid ${SANDBOX_UID} \
        --gid ${SANDBOX_GROUP} \
        --create-home \
        --shell /bin/bash \
        ${SANDBOX_USER}

# -------------------------------------------------------------------
# 5. Passwordless sudo for sandbox user
# -------------------------------------------------------------------
RUN echo "${SANDBOX_USER} ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/${SANDBOX_USER} \
    && chmod 440 /etc/sudoers.d/${SANDBOX_USER}

# -------------------------------------------------------------------
# 6. Create .pi-sandbox directory for sandbox-user-owned config/state
#     This directory is never overlaid by user mounts, and is always
#     read-write for the sandbox user (even in a read-only sandbox).
# -------------------------------------------------------------------
RUN mkdir -p /home/${SANDBOX_USER}/.pi-sandbox \
    && chown ${SANDBOX_USER}:${SANDBOX_GROUP} /home/${SANDBOX_USER}/.pi-sandbox

# -------------------------------------------------------------------
# 7. Configure npm to install global modules into .pi-sandbox
# -------------------------------------------------------------------
ENV NPM_CONFIG_PREFIX=/home/${SANDBOX_USER}/.pi-sandbox
ENV PATH="/home/${SANDBOX_USER}/.pi-sandbox/bin:${PATH}"

# -------------------------------------------------------------------
# 8. Install pi-coding-agent globally (as sandbox user so files are owned by them)
# -------------------------------------------------------------------
USER ${SANDBOX_USER}
RUN npm install -g @mariozechner/pi-coding-agent pi-ask-user pi-searxng

# Create pi-extensions symlink farm (used by entrypoint to discover packages)
# Adding a new package = add symlink here + add flag in pi-sandbox
RUN mkdir -p /home/${SANDBOX_USER}/.pi-sandbox/pi-extensions \
 && ln -s /home/${SANDBOX_USER}/.pi-sandbox/lib/node_modules/pi-ask-user \
         /home/${SANDBOX_USER}/.pi-sandbox/pi-extensions/pi-ask-user \
 && ln -s /home/${SANDBOX_USER}/.pi-sandbox/lib/node_modules/pi-searxng \
         /home/${SANDBOX_USER}/.pi-sandbox/pi-extensions/pi-searxng

# -------------------------------------------------------------------
# 8b. Install local pi packages
# -------------------------------------------------------------------
# Overlay patched pi-searxng index.ts on top of the npm-installed version.
# The npm install in step 8 resolves all dependencies; this COPY overwrites
# only the patched source file with our fix (prepending page title to content).
COPY --chown=${SANDBOX_USER}:${SANDBOX_GROUP} packages/pi-searxng/index.ts /home/${SANDBOX_USER}/.pi-sandbox/lib/node_modules/pi-searxng/index.ts

COPY --chown=${SANDBOX_USER}:${SANDBOX_GROUP} packages/pi-tmux-debug /home/${SANDBOX_USER}/.pi-sandbox/pkg-src/pi-tmux-debug
RUN npm install -g /home/${SANDBOX_USER}/.pi-sandbox/pkg-src/pi-tmux-debug \
 && ln -s /home/${SANDBOX_USER}/.pi-sandbox/lib/node_modules/pi-tmux-debug \
         /home/${SANDBOX_USER}/.pi-sandbox/pi-extensions/pi-tmux-debug

# -------------------------------------------------------------------
# 9. Copy entrypoint script that constructs pi -ne -e <path> ...
#     from PI_ENABLED_EXTENSIONS at startup.
#     Adding a new package = install above + add flag in pi-sandbox.
# -------------------------------------------------------------------
COPY --chmod=755 entrypoint /usr/local/bin/sandbox-entrypoint

# -------------------------------------------------------------------
# 10. Run as sandbox user by default, entrypoint sets up extensions then runs pi
# -------------------------------------------------------------------
WORKDIR /home/${SANDBOX_USER}

ENTRYPOINT ["/usr/local/bin/sandbox-entrypoint"]
CMD ["pi"]
