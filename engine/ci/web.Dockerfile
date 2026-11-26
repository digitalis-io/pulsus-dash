# The engine web image (plan #68 C1 §5.1): the lavapipe image of lavapipe.Dockerfile (`make
# engine-image`) plus the pinned nightly with rust-src and wasm32 for the threaded engine build
# (T03 §5.6), wasm-bindgen, binaryen, Node, Go and Playwright's Chromium, which draws WebGPU and
# WebGL2 on the same lavapipe ICD. Every literal here must equal engine/tools.toml [web] (`cargo
# xtask spec-lint`). It copies nothing from the build context.
ARG BASE=pulsus-engine-ci:local
FROM ${BASE}
ARG APT_SNAPSHOT=20261115T000000Z
ENV PATH=/opt/node/bin:/usr/local/go/bin:/opt/cargo/bin:$PATH PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN rustup toolchain install nightly-2026-11-15 --profile minimal -c rust-src -t wasm32-unknown-unknown \
 && cargo install --locked wasm-bindgen-cli@0.2.130
RUN curl -fsSLo /opt/binaryen.tar.gz https://github.com/WebAssembly/binaryen/releases/download/version_133/binaryen-version_133-x86_64-linux.tar.gz \
 && echo "2dc9c7813f5375db93d96ead4b78222fcc3e2677bbb832297af4797782a37489  /opt/binaryen.tar.gz" | sha256sum -c - \
 && tar -xzf /opt/binaryen.tar.gz -C /opt && rm /opt/binaryen.tar.gz \
 && ln -s /opt/binaryen-version_133/bin/wasm-opt /usr/local/bin/wasm-opt
RUN curl -fsSLo /opt/node.tar.xz https://nodejs.org/dist/v24.22.3/node-v24.22.3-linux-x64.tar.xz \
 && echo "4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb  /opt/node.tar.xz" | sha256sum -c - \
 && mkdir /opt/node && tar -xJf /opt/node.tar.xz -C /opt/node --strip-components=1 && rm /opt/node.tar.xz
RUN curl -fsSLo /opt/go.tar.gz https://go.dev/dl/go1.27.4.linux-amd64.tar.gz \
 && echo "7226736c2339719cda28fbf3a54d71aa63bcefe376e98cef00034268dab24840  /opt/go.tar.gz" | sha256sum -c - \
 && tar -xzf /opt/go.tar.gz -C /usr/local && rm /opt/go.tar.gz
# Chromium's system packages come from the same apt snapshot, so Mesa stays at its pin.
RUN echo "APT::Snapshot \"$APT_SNAPSHOT\";" > /etc/apt/apt.conf.d/50snapshot \
 && apt-get update \
 && npx -y playwright@1.65.0 install --with-deps chromium \
 && test "$(dpkg-query -W -f='${Version}' mesa-vulkan-drivers)" = "25.2.8-0ubuntu0.24.04.4" \
 && rm -rf /var/lib/apt/lists/* /root/.npm
ENV ENGINE_IN_IMAGE=1
