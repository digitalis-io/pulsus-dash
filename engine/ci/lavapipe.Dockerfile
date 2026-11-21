# The engine CI and golden image (plan #68 A.2, T05-004): lavapipe at pinned Mesa and LLVM from a
# dated apt snapshot, the pinned Rust toolchain, cargo-nextest and cargo-deny. Every literal here
# must equal engine/tools.toml (`cargo xtask spec-lint`).
FROM docker.io/library/ubuntu:noble-20261110@sha256:73b999393d07f2bf65a40373778a44dc9a6d54ad7718d29247d8ff9413c4d6a8
ARG APT_SNAPSHOT=20261115T000000Z
ENV DEBIAN_FRONTEND=noninteractive RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:$PATH
# The base image has no CA store and snapshot.ubuntu.com is HTTPS only, so the CA store comes first
# from the noble release pocket (frozen at release; apt verifies it against the signed InRelease and
# the image's archive keyring); `-t noble` takes its dependencies from that pocket too.
RUN apt-get update \
 && apt-get install -y --no-install-recommends -t noble ca-certificates=20240203 \
 && rm -rf /var/lib/apt/lists/*
RUN apt-get update --snapshot "$APT_SNAPSHOT" \
 && apt-get install -y --no-install-recommends --snapshot "$APT_SNAPSHOT" \
      mesa-vulkan-drivers=25.2.8-0ubuntu0.24.04.4 libvulkan1=1.3.275.0-1build1 \
      build-essential=12.10ubuntu1 pkg-config=1.8.1-2build1 curl git \
 && test "$(dpkg-query -W -f='${Version}' libllvm20)" = "1:20.1.2-0ubuntu1~24.04.3" \
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSLo /opt/rustup-init https://static.rust-lang.org/rustup/archive/1.29.3/x86_64-unknown-linux-gnu/rustup-init \
 && echo "b1c8cb14e30889e7e2999e6b69e62d9e9b9ffc0f4df8180564d306d9680e6c55  /opt/rustup-init" | sha256sum -c - \
 && chmod +x /opt/rustup-init && /opt/rustup-init -y --no-modify-path --profile minimal --default-toolchain 1.98.0 \
      -c rustfmt -c clippy -t wasm32-unknown-unknown && rm /opt/rustup-init \
 && cargo install --locked cargo-nextest@0.9.152 cargo-deny@0.20.2
# Mesa 25.2 installs the lavapipe ICD as lvp_icd.json (no architecture suffix).
ENV VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.json
