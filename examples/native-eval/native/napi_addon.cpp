// Minimal C++ N-API (.node) addon for native-debugging evaluation (no node-gyp required).
// Exports: clampSlots(requested: number) -> number
// Intentional bug: uses std::min(requested, 64) instead of std::max(requested, 64).
#include <algorithm>
#include <cstdint>
#include <node_api.h>

static napi_value ClampSlots(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

  int32_t requested = 0;
  if (argc >= 1) {
    napi_get_value_int32(env, args[0], &requested);
  }

  // Intentional bug: should be std::max(requested, 64) so at least 64 slots are allocated.
  int32_t actual = std::min(requested, 64);

  napi_value result;
  napi_create_int32(env, actual, &result);
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "clampSlots", NAPI_AUTO_LENGTH, ClampSlots, nullptr, &fn);
  napi_set_named_property(env, exports, "clampSlots", fn);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
