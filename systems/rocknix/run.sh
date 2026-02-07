#!/bin/bash

LOG_FILE="/roms/jsgames/.jsgamelauncher.log"

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') - $1" >> "$LOG_FILE"
}

export LD_LIBRARY_PATH=/usr/lib

# Source bash_profile for nvm
if [ -f ~/.bash_profile ]; then
    source ~/.bash_profile
else
    log "ERROR: ~/.bash_profile not found"
fi

# Try to use node 22 via nvm
if command -v nvm &> /dev/null; then
    nvm use 22 2>> "$LOG_FILE"
else
    log "WARNING: nvm not found, trying system node"
fi

# Check if node is available
if ! command -v node &> /dev/null; then
    log "ERROR: Node.js not found! Please run the installer again."
    log "Try: curl -sL https://raw.githubusercontent.com/monteslu/jsgamelauncher/main/installers/install-rocknix.sh | bash"
    exit 1
fi

cd /storage/jsgamelauncher

log "Starting jsgamelauncher with: $@"
node index.js "$@" 2>> "$LOG_FILE"
EXIT_CODE=$?
log "jsgamelauncher exited with code: $EXIT_CODE"
exit $EXIT_CODE
