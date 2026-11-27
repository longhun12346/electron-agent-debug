// Native module for the native-debugging evaluations (see ../README.md).
// It is meant to misbehave: the evaluations ask an agent to find out why.
// Windows, Linux and macOS build from this one file; the three exported functions behave the same on each.
#ifdef _WIN32
#define NOMINMAX
#include <windows.h>
#define EXPORT __declspec(dllexport)
#else
#include <dirent.h>
#include <strings.h>
#include <sys/stat.h>
#define EXPORT __attribute__((visibility("default")))
#endif

#include <algorithm>
#include <cstdint>
#include <string>
#include <vector>

namespace {

struct Entry {
  std::string name;
  bool is_dir;
  int64_t size;
};

#ifdef _WIN32

std::vector<Entry> list_entries(const std::string& dir) {
  std::vector<Entry> entries;
  WIN32_FIND_DATAA data;
  HANDLE handle = FindFirstFileA((dir + "\\*").c_str(), &data);
  if (handle == INVALID_HANDLE_VALUE) return entries;
  do {
    std::string name = data.cFileName;
    if (name != "." && name != "..") {
      bool is_dir = (data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
      entries.push_back({name, is_dir, (static_cast<int64_t>(data.nFileSizeHigh) << 32) | data.nFileSizeLow});
    }
  } while (FindNextFileA(handle, &data));
  FindClose(handle);
  std::sort(entries.begin(), entries.end(), [](const Entry& a, const Entry& b) {
    return lstrcmpiA(a.name.c_str(), b.name.c_str()) < 0;
  });
  return entries;
}

const char kSeparator = '\\';

#else

std::vector<Entry> list_entries(const std::string& dir) {
  std::vector<Entry> entries;
  DIR* handle = opendir(dir.c_str());
  if (handle == nullptr) return entries;
  while (dirent* item = readdir(handle)) {
    std::string name = item->d_name;
    if (name == "." || name == "..") continue;
    struct stat info;
    if (stat((dir + "/" + name).c_str(), &info) != 0) continue;
    entries.push_back({name, S_ISDIR(info.st_mode), static_cast<int64_t>(info.st_size)});
  }
  closedir(handle);
  std::sort(entries.begin(), entries.end(), [](const Entry& a, const Entry& b) {
    return strcasecmp(a.name.c_str(), b.name.c_str()) < 0;
  });
  return entries;
}

const char kSeparator = '/';

// Brings a path into the file system's encoding. The bytes are taken to be Latin-1 and re-encoded as UTF-8.
std::string to_file_system_encoding(const std::string& path) {
  std::string out;
  for (unsigned char c : path) {
    if (c < 0x80) {
      out += static_cast<char>(c);
    } else {
      out += static_cast<char>(0xC0 | (c >> 6));
      out += static_cast<char>(0x80 | (c & 0x3F));
    }
  }
  return out;
}

#endif

int64_t total_size(const std::string& dir) {
  int64_t total = 0;
  for (const auto& entry : list_entries(dir)) {
    if (entry.is_dir) {
      int64_t sub = total_size(dir + kSeparator + entry.name);
      if (sub == 0) break;
      total += sub;
    } else {
      total += entry.size;
    }
  }
  return total;
}

}  // namespace

extern "C" {

// Total size in bytes of all files under `dir` (UTF-8 path), including subdirectories.
EXPORT int64_t sum_sizes(const char* dir) { return total_size(dir); }

// 1 if `root`/`name` is an existing directory, otherwise 0. Both arguments are UTF-8.
EXPORT int has_subdir(const char* root, const char* name) {
  std::string path = std::string(root) + kSeparator + name;
#ifdef _WIN32
  DWORD attributes = GetFileAttributesA(path.c_str());
  return attributes != INVALID_FILE_ATTRIBUTES && (attributes & FILE_ATTRIBUTE_DIRECTORY) ? 1 : 0;
#else
  struct stat info;
  return stat(to_file_system_encoding(path).c_str(), &info) == 0 && S_ISDIR(info.st_mode) ? 1 : 0;
#endif
}

// Number of worker slots to start: at least 64, or `requested` when that is larger.
EXPORT int init_slots(int requested) { return std::min(requested, 64); }

// Returns the length of `label` (UTF-8), or 0 when `label` is null.
// Intentional bug: dereferences `label` without a null check, causing an Access Violation / SIGSEGV when null is passed.
EXPORT int label_length(const char* label) {
  int count = 0;
  while (label[count] != '\0') count++;
  return count;
}

}  // extern "C"
