#!/bin/sh
# entrypoint.sh — Optionally fetches GUARD_PRIVATE_KEY from Vaultwarden at container
# start (not deploy time), so the key only ever lives in container memory.
#
# Activation is opt-in: set VAULT_FETCH_GUARD_KEY=true and provide:
#   VAULT_ITEM_NAME        Name of the vault item holding the key
#   VAULT_PASSWORD_FILE    Path to file with the master password
#   VAULT_SERVER_URL       Bitwarden server URL (default: https://dfxvault.com)
#   VAULT_FIELD            Item field to read (default: GUARD_PRIVATE_KEY)
#
# When GUARD_ENABLED=true and VAULT_FETCH_GUARD_KEY=true the entrypoint fails fast
# if the vault is unreachable or the item is missing — the service must not silently
# start without a signing key.

set -e

if [ "${VAULT_FETCH_GUARD_KEY:-false}" = "true" ]; then
	: "${VAULT_ITEM_NAME:?VAULT_ITEM_NAME is required when VAULT_FETCH_GUARD_KEY=true}"
	: "${VAULT_PASSWORD_FILE:?VAULT_PASSWORD_FILE is required when VAULT_FETCH_GUARD_KEY=true}"
	: "${VAULT_BW_DATA_DIR:?VAULT_BW_DATA_DIR is required when VAULT_FETCH_GUARD_KEY=true (mounted from host)}"

	VAULT_SERVER_URL="${VAULT_SERVER_URL:-https://dfxvault.com}"
	VAULT_FIELD="${VAULT_FIELD:-GUARD_PRIVATE_KEY}"

	if [ ! -r "$VAULT_PASSWORD_FILE" ]; then
		echo "entrypoint: vault password file $VAULT_PASSWORD_FILE not readable" >&2
		exit 1
	fi

	# Copy bw data to a writable per-container location so the host's bw state stays untouched
	# even if `bw sync` updates the local cache. Without this, two containers sharing the same
	# mount would race on data.json writes.
	BW_RUNTIME_DIR="$(mktemp -d /tmp/bw-runtime.XXXXXX)"
	cp -r "$VAULT_BW_DATA_DIR"/* "$BW_RUNTIME_DIR"/ 2>/dev/null || true
	export BITWARDENCLI_APPDATA_DIR="$BW_RUNTIME_DIR"

	echo "entrypoint: configuring bw server $VAULT_SERVER_URL"
	bw config server "$VAULT_SERVER_URL" > /dev/null

	echo "entrypoint: unlocking vault"
	BW_PASSWORD="$(cat "$VAULT_PASSWORD_FILE")"
	export BW_PASSWORD
	BW_SESSION="$(bw unlock --passwordenv BW_PASSWORD --raw)"
	export BW_SESSION
	unset BW_PASSWORD

	echo "entrypoint: syncing vault"
	bw sync --session "$BW_SESSION" > /dev/null

	echo "entrypoint: fetching $VAULT_FIELD from item '$VAULT_ITEM_NAME'"
	GUARD_PRIVATE_KEY="$(bw get item "$VAULT_ITEM_NAME" --session "$BW_SESSION" \
		| node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const i=JSON.parse(s);const f=(i.fields||[]).find(x=>x.name===process.argv[1]);if(!f){process.stderr.write("field not found: "+process.argv[1]+"\n");process.exit(2);}process.stdout.write(f.value);}' "$VAULT_FIELD")"
	export GUARD_PRIVATE_KEY

	bw lock --session "$BW_SESSION" > /dev/null || true
	rm -rf "$BW_RUNTIME_DIR"
	unset BW_SESSION BITWARDENCLI_APPDATA_DIR

	echo "entrypoint: GUARD_PRIVATE_KEY loaded into env"
fi

exec "$@"
