# syntax=docker/dockerfile:1
#
# Build from this directory:  docker build -t orya-halo-gateway apps/gateway
# The image is about 30 MB: one static-ish binary on distroless, run as non-root.

FROM rust:1-slim-bookworm AS build
WORKDIR /app

# Build dependencies first so they are cached until Cargo.toml or Cargo.lock change.
# gcc is in the image already; the ring crate needs nothing more (no cmake, no nasm).
COPY Cargo.toml Cargo.lock ./
RUN mkdir src \
    && echo "fn main() {}" > src/main.rs \
    && touch src/lib.rs \
    && cargo build --release --locked \
    && rm -rf src

COPY src ./src
# Bump the timestamps so cargo rebuilds the crate rather than reusing the stub.
RUN touch src/main.rs src/lib.rs && cargo build --release --locked

# glibc and libgcc only. TLS roots are compiled into the binary, so the image
# needs no certificate bundle of its own.
FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=build /app/target/release/orya-halo-gateway /usr/local/bin/orya-halo-gateway
ENV BIND_ADDR=0.0.0.0:8787
EXPOSE 8787
USER nonroot:nonroot
ENTRYPOINT ["/usr/local/bin/orya-halo-gateway"]
