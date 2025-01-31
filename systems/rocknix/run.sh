#!/bin/bash

export LD_LIBRARY_PATH=/usr/lib

source ~/.bash_profile
nvm use 22

cd /storage/jsgamelauncher
if [ -f package.json ] && [ ! -d node_modules ]; then
  npm install
fi

node index.js $@
