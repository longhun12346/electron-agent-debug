// Native module for the native-debugging evaluations (see ../README.md).
// It is meant to misbehave: the evaluations ask an agent to find out why.
#define NOMINMAX
#include <windows.h>

#include <algorithm>
#include <cstdint>
#include <string>
#include <vector>

namespace {

std::vector<WIN32_FIND_DATAA> list_entries(const std::string& dir) {
  std::vector<WIN32_FIND_DATAA> entries;
  WIN32_FIND_DATAA data;
  HANDLE handle = FindFirstFileA((dir + "\\*").c_str(), &data);
  if (handle == INVALID_HANDLE_VALUE) return entries;
  do {
    std::string name = data.cFileName;
    if (name != "." && name != "..") entries.push_back(data);
  } while (FindNextFileA(handle, &data));
  FindClose(handle);
  std::sort(entries.begin(), entries.end(), [](const WIN32_FIND_DATAA& a, const WIN32_FIND_DATAA& b) {
    return lstrcmpiA(a.cFileName, b.cFileName) < 0;
  });
  return entries;
}

int64_t total_size(const std::string& dir) {
  int64_t total = 0;
  for (const auto& entry : list_entries(dir)) {
    if (entry.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
      int64_t sub = total_size(dir + "\\" + entry.cFileName);
      if (sub == 0) break;
      total += sub;
    } else {
      total += (static_cast<int64_t>(entry.nFileSizeHigh) << 32) | entry.nFileSizeLow;
    }
  }
  return total;
}

}  // namespace

extern "C" {

// Total size in bytes of all files under `dir` (UTF-8 path), including subdirectories.
__declspec(dllexport) int64_t sum_sizes(const char* dir) { return total_size(dir); }

// 1 if `root`\`name` is an existing directory, otherwise 0. Both arguments are UTF-8.
__declspec(dllexport) int has_subdir(const char* root, const char* name) {
  std::string path = std::string(root) + "\\" + name;
  DWORD attributes = GetFileAttributesA(path.c_str());
  return attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_DIRECTORY) ? 1 : 0;
}

// Number of worker slots to start: at least 64, or `requested` when that is larger.
__declspec(dllexport) int init_slots(int requested) { return std::min(requested, 64); }

}  // extern "C"
