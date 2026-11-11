#!/bin/sh
# Two ways to choose the runtime user:
#
#   PUID/PGID     start as root, chown the writable directories, then drop to
#                 these ids. Defaults to 1000:1000.
#   --user        start as that user directly. The entrypoint sees a non-root
#                 uid and never touches ownership.
#
# HOME is pinned to /home/bun either way. Without ZCODE_PROXY_CREDENTIAL_SECRET
# the store seed is derived from the home path, so a different HOME makes every
# existing store undecryptable.
set -eu

log() {
	echo "docker-entrypoint: $*" >&2
}

# `docker run <image> --flag` means `bun --flag`, and a non-executable argument
# is a script for bun to run. No argument at all also means bun, which keeps
# `set -u` from tripping over an absent $1.
first="${1:-}"
if [ -z "$first" ] || [ "${first#-}" != "$first" ] || [ -z "$(command -v "$first")" ] || { [ -f "$first" ] && ! [ -x "$first" ]; }; then
	set -- /usr/local/bin/bun "$@"
fi

# The image sets HOME=/home/bun. Root and a remapped uid with no passwd entry
# otherwise get /root and "/" from the runtime.
case "${HOME:-}" in
	"" | / | /root) HOME=/home/bun ;;
esac
export HOME

if [ "$(id -u)" != "0" ]; then
	# --user already made the choice. Chowning would fail, and silently
	# honouring PUID here would hide a misconfiguration.
	if [ -n "${PUID:-}" ] || [ -n "${PGID:-}" ]; then
		log "ignoring PUID/PGID: already running as uid $(id -u); unset them or drop 'user:' from the compose file"
	fi
	exec "$@"
fi

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

case "$PUID$PGID" in
*[!0-9]*)
	log "PUID and PGID must be numeric (got PUID='$PUID' PGID='$PGID')"
	exit 64
	;;
esac

# /data holds the store; HOME holds the captcha CDN cache. A bind mount keeps
# the host's ownership, so the unprivileged process may not be able to write
# either one yet.
for dir in /data "$HOME"; do
	if [ ! -d "$dir" ]; then mkdir -p "$dir"; fi
	# chown -R over a year of request logs is the slow part of a restart, so
	# skip it when the owner already matches.
	if [ "$(stat -c %u:%g "$dir")" != "$PUID:$PGID" ]; then
		# Read-only and NFS mounts can fail here while the data is already
		# usable, so warn and continue instead of refusing to start.
		chown -R "$PUID:$PGID" "$dir" 2>/dev/null ||
			log "could not chown $dir to $PUID:$PGID (read-only or rootless mount?); continuing"
	fi
done

if [ "$PUID" = "0" ]; then
	log "running as root because PUID=0; anything in the container can read the panel and the store"
fi

# su-exec rewrites HOME from the target's passwd entry and falls back to "/"
# when that uid has none, which is every remapped uid. Re-apply the pinned
# value after it drops privileges. exec keeps the proxy as PID 1 so docker stop
# reaches it directly.
exec su-exec "$PUID:$PGID" env HOME="$HOME" "$@"
