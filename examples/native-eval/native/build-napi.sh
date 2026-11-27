#!/usr/bin/env sh
# Builds napi_addon.node as a Debug build (with .dSYM on macOS, no node-gyp required).
# Reuses node-api-headers bundled in ../node_modules/koffi/vendor/node-api-headers.
set -eu
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NAPI_INC="$DIR/../node_modules/koffi/vendor/node-api-headers/include"
if [ ! -f "$NAPI_INC/node_api.h" ]; then
  echo "node_api.h not found. Run npm install in examples/native-eval first." >&2
  exit 1
fi
mkdir -p "$DIR/build"
CXX="${CXX:-c++}"
if [ "$(uname -s)" = "Darwin" ]; then
  "$CXX" -std=c++17 -O0 -g -fPIC -DNODE_GYP_MODULE_NAME=napi_addon -I"$NAPI_INC" -c "$DIR/napi_addon.cpp" -o "$DIR/build/napi_addon.o"
  "$CXX" -shared -undefined dynamic_lookup -o "$DIR/build/napi_addon.node" "$DIR/build/napi_addon.o"
  dsymutil "$DIR/build/napi_addon.node" -o "$DIR/build/napi_addon.node.dSYM"
else
  "$CXX" -std=c++17 -O0 -g -fPIC -shared -DNODE_GYP_MODULE_NAME=napi_addon -I"$NAPI_INC" "$DIR/napi_addon.cpp" -o "$DIR/build/napi_addon.node"
fi
