#!/bin/sh
# OpenSSH resolves ~ through passwd, not HOME. Keep its user files in the workspace.
config="$HOME/.ssh/config"
if [ ! -f "$config" ]; then
  config=/dev/null
fi
exec /usr/bin/ssh -F "$config" \
  -o "UserKnownHostsFile=\"$HOME/.ssh/known_hosts\"" \
  -o "IdentityFile=\"$HOME/.ssh/id_rsa\"" \
  -o "IdentityFile=\"$HOME/.ssh/id_ecdsa\"" \
  -o "IdentityFile=\"$HOME/.ssh/id_ecdsa_sk\"" \
  -o "IdentityFile=\"$HOME/.ssh/id_ed25519\"" \
  -o "IdentityFile=\"$HOME/.ssh/id_ed25519_sk\"" \
  "$@"
