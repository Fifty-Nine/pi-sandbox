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
        wget \
        gnupg2 \
        gcc-arm-none-eabi \
        # QMK firmware build dependencies
        avr-libc \
        avrdude \
        binutils-arm-none-eabi \
        binutils-avr \
        binutils-riscv64-unknown-elf \
        clang-format \
        dfu-programmer \
        dfu-util \
        diffutils \
        gcc-avr \
        gcc-riscv64-unknown-elf \
        libhidapi-hidraw0 \
        libnewlib-arm-none-eabi \
        libusb-dev \
        picolibc-riscv64-unknown-elf \
        python3-pip \
        teensy-loader-cli \
        unzip \
        zip \
    && apt-get build-dep -y tmux \
    && rm -rf /var/lib/apt/lists/*

# -------------------------------------------------------------------
# 1a. Install Atlassian CLI (acli) from APT repository
# -------------------------------------------------------------------
RUN mkdir -p -m 755 /etc/apt/keyrings \
    && wget -nv -O- https://acli.atlassian.com/gpg/public-key.asc | gpg --dearmor -o /etc/apt/keyrings/acli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/acli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/acli-archive-keyring.gpg] https://acli.atlassian.com/linux/deb stable main" > /etc/apt/sources.list.d/acli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends acli \
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
# 2. Install uv + Python 3.14 (via uv's standalone Python builds)
# -------------------------------------------------------------------
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh

ENV UV_PYTHON_INSTALL_DIR=/opt/python
ARG PYTHON_VERSION
RUN uv python install ${PYTHON_VERSION} \
    && PYTHON_BIN="$(uv python find ${PYTHON_VERSION})" \
    && ln -s "$PYTHON_BIN" /usr/local/bin/python3 \
    && ln -s "$PYTHON_BIN" /usr/local/bin/python \
    && ln -s "$(dirname "$PYTHON_BIN")/pip3" /usr/local/bin/pip3

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
# 7. Configure npm global prefix + PATH for sandbox binaries
#     NPM_CONFIG_PREFIX is retained for runtime npm install -g use
#     (e.g., pi-tmux-debug local package install).
#     Main npm packages are installed via local npm install in
#     .pi-sandbox/npm-packages/ (see step 8).
# -------------------------------------------------------------------
ENV NPM_CONFIG_PREFIX=/home/${SANDBOX_USER}/.pi-sandbox
ENV PATH="/home/${SANDBOX_USER}/.pi-sandbox/npm-packages/node_modules/.bin:/home/${SANDBOX_USER}/.pi-sandbox/bin:${PATH}"

# -------------------------------------------------------------------
# 8. Install npm packages from package.json (as sandbox user).
#
#     COPY package.json BEFORE npm install so that Docker/Podman caches
#     the install layer based on the file content. Changing a version
#     in package.json invalidates the COPY cache, which cascades to
#     invalidate the npm install cache — triggering a fresh install.
#
#     This replaces the old `npm install -g <pkg1> <pkg2> ...` approach,
#     which was always cached by Podman regardless of available updates.
#
#     To update a package: change its version in package.json and rebuild.
# -------------------------------------------------------------------
COPY --chown=${SANDBOX_USER}:${SANDBOX_GROUP} package.json /home/${SANDBOX_USER}/.pi-sandbox/npm-packages/
RUN chown -R "${SANDBOX_USER}:${SANDBOX_GROUP}" /opt/python
USER ${SANDBOX_USER}
ENV UV_PROJECT_ENVIRONMENT="/home/${SANDBOX_USER}/.venv"
RUN cd /home/${SANDBOX_USER}/.pi-sandbox/npm-packages && npm install \
 && uv venv ${UV_PROJECT_ENVIRONMENT}

# Create pi-extensions symlink farm (used by entrypoint to discover packages)
# Adding a new package = add to package.json + add symlink here + add flag in pi-sandbox
RUN mkdir -p /home/${SANDBOX_USER}/.pi-sandbox/pi-extensions \
 && ln -s /home/${SANDBOX_USER}/.pi-sandbox/npm-packages/node_modules/pi-ask-user \
         /home/${SANDBOX_USER}/.pi-sandbox/pi-extensions/pi-ask-user \
 && ln -s /home/${SANDBOX_USER}/.pi-sandbox/npm-packages/node_modules/@blazer2k/searxng-suite \
         /home/${SANDBOX_USER}/.pi-sandbox/pi-extensions/searxng-suite \
 && ln -s /home/${SANDBOX_USER}/.pi-sandbox/npm-packages/node_modules/pi-ollama-cloud-provider \
         /home/${SANDBOX_USER}/.pi-sandbox/pi-extensions/pi-ollama-cloud-provider

# -------------------------------------------------------------------
# 8b. Install local pi packages
# -------------------------------------------------------------------
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
