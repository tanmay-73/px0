# Stage 1: Bundle the frontend (Monaco needs Bun's bundler)
FROM oven/bun:1-alpine AS web-builder
WORKDIR /build
COPY package.json package-lock.json ./
RUN bun install
COPY scripts/ ./scripts/
COPY web/ ./web/
RUN bun scripts/build-web.js

# Stage 2: Build static Go binary
FROM golang:1.25-alpine AS go-builder
WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# The bundled frontend (web/dist) and compressed vendor assets.
COPY --from=web-builder /build/web/ ./web/
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /bin/px0 .

# Stage 3: Minimal runtime container
FROM alpine:3.21
# bash for the integrated terminal (off in a container unless px0 runs with -terminal).
RUN apk --no-cache add ca-certificates git bash \
    && adduser -D -u 1000 -s /bin/bash px0
COPY --from=go-builder /bin/px0 /usr/local/bin/px0

USER px0
WORKDIR /workspace
EXPOSE 7777
# With no folder argument px0 serves the workbench: every repository under the
# working directory (or under -roots) can be listed, opened and switched between.
# Pass a folder instead (`docker run ... px0:local /workspace`) for a single workspace.
ENTRYPOINT ["px0", "-host", "0.0.0.0", "-no-open"]
