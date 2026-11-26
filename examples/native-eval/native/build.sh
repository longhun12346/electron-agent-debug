#!/bin/sh
# Builds the native library as a Debug build with symbols (Linux: libnative_eval.so, macOS: libnative_eval.dylib plus a
# .dSYM bundle). Needs a C++17 compiler (g++ or clang++). Set CXX to pick one. Run from any directory:
#   sh /full/path/to/examples/native-eval/native/build.sh
set -eu
cd "$(dirname "$0")"
mkdir -p build
CXX="${CXX:-c++}"
case "$(uname -s)" in
  Darwin)
    "$CXX" -std=c++17 -g -O0 -fvisibility=hidden -dynamiclib native_eval.cpp -o build/libnative_eval.dylib
    dsymutil build/libnative_eval.dylib
    echo "built build/libnative_eval.dylib"
    ;;
  *)
    "$CXX" -std=c++17 -g -O0 -fvisibility=hidden -shared -fPIC native_eval.cpp -o build/libnative_eval.so
    echo "built build/libnative_eval.so"
    ;;
esac
