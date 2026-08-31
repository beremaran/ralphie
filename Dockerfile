# syntax=docker/dockerfile:1

# Release metadata is public and supplied by the release workflow. Local builds
# retain useful sentinels while release builds pass only validated values.
# Never add credentials or other private values as ARG, ENV, LABEL, or COPY
# inputs: they would be retained in image history or build metadata.
ARG RALPHIE_VERSION=local
ARG RALPHIE_COMMIT_SHA=local

# ---- build stage ----------------------------------------------------------
# Build the native binary from source. The native target compiles for the
# builder's OS/arch, so a multi-arch image (docker buildx --platform ...)
# produces one binary per platform.
FROM oven/bun:1 AS build
ARG RALPHIE_VERSION
ARG RALPHIE_COMMIT_SHA
WORKDIR /src
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
# Copy only the files needed for the native build, even if a caller supplies a
# broader context than the repository's deny-by-default .dockerignore.
COPY index.ts ./index.ts
COPY src ./src
COPY scripts/build.ts ./scripts/build.ts
RUN bun run build -- --commit-sha "$RALPHIE_COMMIT_SHA"

# ---- runtime stage --------------------------------------------------------
# Keep the runtime image Debian-based so the native binary and the external
# commands used by Ralphie and Pi have their complete runtime dependencies.
FROM debian:bookworm-slim
ARG RALPHIE_VERSION
ARG RALPHIE_COMMIT_SHA
RUN apt-get update \
    && apt-get install --no-install-recommends --yes \
        bash \
        ca-certificates \
        fd-find \
        gh \
        git \
        openssh-client \
        ripgrep \
    && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /home/nonroot \
    && chown 65532:65532 /home/nonroot
ENV HOME=/home/nonroot
WORKDIR /home/nonroot
USER 65532:65532
LABEL org.opencontainers.image.title="ralphie" \
      org.opencontainers.image.description="Turn a GitHub issue queue into reviewed commits with Pi." \
      org.opencontainers.image.source="https://github.com/beremaran/ralphie" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="$RALPHIE_VERSION" \
      org.opencontainers.image.revision="$RALPHIE_COMMIT_SHA"
COPY --from=build /src/dist/cli /usr/local/bin/ralphie
ENTRYPOINT ["ralphie"]
