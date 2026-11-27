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
    # On macOS the debug information stays in the object file and the dylib only records where it is, so the object file
    # has to be kept (build/native_eval.o) for dsymutil to collect it; compiling and linking in one step would delete it.
    "$CXX" -std=c++17 -g -O0 -fvisibility=hidden -fPIC -c native_eval.cpp -o build/native_eval.o
    "$CXX" -dynamiclib build/native_eval.o -o build/libnative_eval.dylib
    dsymutil build/libnative_eval.dylib
    echo "built build/libnative_eval.dylib"
    ;;
  *)
    "$CXX" -std=c++17 -g -O0 -fvisibility=hidden -shared -fPIC native_eval.cpp -o build/libnative_eval.so
    echo "built build/libnative_eval.so"
    ;;
esac
