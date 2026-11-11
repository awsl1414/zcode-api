# syntax=docker/dockerfile:1

# Keep Bun aligned with CI and desktop builds. Only production dependencies
# are needed even in the builder: both bundles use Bun's built-in bundler.
FROM oven/bun:1.4.4-alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
# No registry flag here on purpose: bun downloads the exact tarball URLs
# recorded in `bun.lock` (all on registry.npmmirror.com) and ignores
# `--registry` for them, so the flag would suggest a mirror switch it cannot
# perform.
RUN bun install --frozen-lockfile --production
COPY tsconfig.json ./
COPY src ./src
COPY scripts/build-fork-worker.ts ./scripts/build-fork-worker.ts
# Preserve the worker file asset as well as the main bundle. Omitting it
# degrades captcha solving to the main thread (issue #54).
RUN bun run scripts/build-fork-worker.ts \
    && bun build --target=bun --minify --keep-names --define 'require.resolve=undefined' src/index.ts --outdir /app/dist

FROM oven/bun:1.4.4-alpine
WORKDIR /app
# Runtime contains the bundled application and worker; no node_modules,
# TypeScript sources, tests, or additional build tools enter this stage.
COPY --from=build /app/dist ./
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# su-exec is the Alpine-sized gosu: it drops root and execs, so sudo's signal
# forwarding never enters the picture. Root is needed only long enough to chown
# the bind mount and the captcha cache directory under /home/bun.
#
# `chmod` in the RUN rather than `COPY --chmod`: the checkout does not always
# carry the executable bit, and buildx is not installed on every build host.
RUN apk add --no-cache su-exec \
    && chmod 0755 /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /data \
    && chown bun:bun /data

# Start arguments, not user configuration: the YAML does not exist yet
# when the process boots, so its location cannot live inside it.
ENV ZCODE_PROXY_CONFIG=/data/config.yaml
# The store holds accounts.json, apikeys.json, users.json, policy.json and the
# runtime-written requests.jsonl / activities.jsonl / control.port. Left
# at its default ($HOME/.zcode-proxy) those files would sit outside the /data
# volume, so recreating the container would lose every account added in the
# panel, and no restart brings those back.
ENV ZCODE_PROXY_STORE_DIR=/data
# `docker logs` reads line by line; the desktop table layout is noise there.
ENV ZCODE_LOG_FORMAT=compact
# Pinned instead of taken from the passwd entry: without
# ZCODE_PROXY_CREDENTIAL_SECRET the store seed is derived from the home path,
# and a remapped uid has no passwd record, so HOME would fall back to "/" and
# silently make every existing store undecryptable.
ENV HOME=/home/bun

# One port for both the data plane and the panel: the panel is mounted on the
# proxy's own listener, so there is no second port to publish.
EXPOSE 8080

# `/healthz` rather than `/health`: this is the panel's liveness probe, which
# answers without a credential. `/health` sits behind the data-plane API key
# gate and starts returning 401 the moment the user creates their first key,
# which would mark a perfectly healthy container as unhealthy. `/healthz` is
# only served while the panel is on (its default); a container started with
# `--no-panel` reports unhealthy, so probe the port yourself in that case.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

# No USER line: the entrypoint needs root to chown, and drops to PUID:PGID
# (1000:1000 by default, which is the image's `bun` user) before starting the
# proxy. `--user` also works and skips the remapping.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["bun", "index.js", "serve"]
