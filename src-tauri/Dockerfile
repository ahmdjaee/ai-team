# Lingkungan build aplikasi desktop: Rust, pustaka dev Tauri, dan Bun.
# Dipakai lewat `bun run desktop:docker:*` (scripts/desktop-docker.ts); aplikasinya sendiri
# tetap berjalan langsung di desktop, bukan di dalam kontainer.
#
# Ubuntu 22.04 adalah rilis tertua yang didukung Tauri v2. Biner yang dibangun di sini
# terikat pada glibc 2.35, sehingga jalan di 22.04 dan semua rilis sesudahnya.
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential pkg-config curl wget file unzip git ca-certificates xdg-utils \
        libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev libxdo-dev \
    && rm -rf /var/lib/apt/lists/*

# Toolchain di /opt supaya terbaca pengguna mana pun: kontainer dijalankan dengan UID host,
# dan CARGO_HOME dialihkan ke folder cache milik pengguna itu saat dijalankan.
ENV RUSTUP_HOME=/opt/rustup \
    CARGO_HOME=/opt/cargo \
    PATH=/opt/cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
        | sh -s -- -y --profile minimal --component clippy --no-modify-path \
    && chmod -R a+rX /opt/rustup /opt/cargo

# Versi Bun disamakan dengan mesin pengembangan supaya bun.lock cocok. Biner ini juga yang
# disalin scripts/desktop-stage.ts ke dalam paket sebagai runtime server.
ARG BUN_VERSION=1.4.4
RUN curl -fsSL -o /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip" \
    && unzip -q /tmp/bun.zip -d /tmp \
    && install -m 755 /tmp/bun-linux-x64/bun /usr/local/bin/bun \
    && rm -rf /tmp/bun.zip /tmp/bun-linux-x64

# linuxdeploy (pembuat AppImage) sendiri berupa AppImage; di kontainer tidak ada FUSE.
ENV APPIMAGE_EXTRACT_AND_RUN=1
