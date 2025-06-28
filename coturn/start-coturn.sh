#!/bin/sh

# DLUX Presence Coturn Startup Script
# Substitutes environment variables and starts turnserver

echo "Starting DLUX Presence TURN Server..."

# Set default TURN_SECRET if not provided
if [ -z "$TURN_SECRET" ]; then
    echo "WARNING: TURN_SECRET not set, using default (not secure for production!)"
    export TURN_SECRET="default_turn_secret_change_me"
fi

# Create runtime config with environment variable substitution
sed "s/__TURN_SECRET__/$TURN_SECRET/g" /etc/coturn/turnserver.conf > /tmp/turnserver_runtime.conf

echo "TURN server configuration:"
echo "- Realm: presence.dlux.io"
echo "- Listening ports: 3478 (STUN/TURN), 5349 (TLS disabled)"
echo "- Relay ports: 49152-65535"
echo "- Auth method: Shared secret"
echo "- Secret: [HIDDEN]"

# Start turnserver with the processed config
exec turnserver -c /tmp/turnserver_runtime.conf 