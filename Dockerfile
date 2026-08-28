# syntax=docker/dockerfile:1

# Release metadata is supplied by the release workflow. Local builds retain a
# useful sentinel while release builds must pass the validated values.
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
COPY . .
RUN bun run build -- --commit-sha "$RALPHIE_COMMIT_SHA"

# ---- runtime stage --------------------------------------------------------
FROM gcr.io/distroless/base-debian12:nonroot
ARG RALPHIE_VERSION
ARG RALPHIE_COMMIT_SHA
LABEL org.opencontainers.image.title="ralphie" \
      org.opencontainers.image.description="Turn a GitHub issue queue into reviewed commits with Pi." \
      org.opencontainers.image.source="https://github.com/beremaran/ralphie" \
      org.opencontainers.image.version="$RALPHIE_VERSION" \
      org.opencontainers.image.revision="$RALPHIE_COMMIT_SHA"
COPY --from=build /src/dist/cli /usr/local/bin/ralphie
ENTRYPOINT ["ralphie"]
