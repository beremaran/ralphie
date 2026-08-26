# syntax=docker/dockerfile:1

# ---- build stage ----------------------------------------------------------
# Build the native binary from source. The native target compiles for the
# builder's OS/arch, so a multi-arch image (docker buildx --platform ...)
# produces one binary per platform.
FROM oven/bun:1 AS build
WORKDIR /src
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# ---- runtime stage --------------------------------------------------------
FROM gcr.io/distroless/base-debian12:nonroot
LABEL org.opencontainers.image.title="ralphie" \
      org.opencontainers.image.description="Turn a GitHub issue queue into reviewed commits with Pi." \
      org.opencontainers.image.source="https://github.com/beremaran/ralphie"
COPY --from=build /src/dist/cli /usr/local/bin/ralphie
ENTRYPOINT ["ralphie"]
