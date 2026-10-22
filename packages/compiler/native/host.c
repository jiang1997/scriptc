#ifndef _WIN32
#define _POSIX_C_SOURCE 200809L
#endif
#include <stdint.h>
#include <limits.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#else
#include <sys/stat.h>
#include <unistd.h>
#endif

/* Accept only directories owned by this user with private POSIX access.
 * Windows inherits the user's cache ACL; reject reparse points so an
 * installed cache directory cannot redirect compiler payloads elsewhere. */
uint8_t scriptc_native_private_directory(const uint8_t *bytes, size_t size, uint8_t harden) {
  if (size == 0 || memchr(bytes, 0, size) != NULL) return 0;
#ifdef _WIN32
  (void)harden;
  if (size > INT_MAX) return 0;
  int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, (const char *)bytes, (int)size, NULL, 0);
  if (length <= 0) return 0;
  wchar_t *path = malloc(((size_t)length + 1) * sizeof(wchar_t));
  if (!path) return 0;
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, (const char *)bytes, (int)size, path, length) != length) { free(path); return 0; }
  path[length] = 0;
  DWORD attrs = GetFileAttributesW(path);
  free(path);
  return attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_DIRECTORY) != 0 && (attrs & FILE_ATTRIBUTE_REPARSE_POINT) == 0;
#else
  char *path = malloc(size + 1);
  if (!path) return 0;
  memcpy(path, bytes, size);
  path[size] = 0;
  struct stat info;
  int ok = lstat(path, &info) == 0 && S_ISDIR(info.st_mode) && info.st_uid == getuid();
  if (ok && harden && (info.st_mode & 077) != 0) ok = chmod(path, 0700) == 0;
  if (ok) ok = lstat(path, &info) == 0 && S_ISDIR(info.st_mode) && info.st_uid == getuid() && (info.st_mode & 077) == 0;
  free(path);
  return ok;
#endif
}

/* The runtime's full sweep after a phase's data died (scr_rc.h). */
void scr_collect_cycles_phase(void);

/* Reclaims the cycles a finished compiler phase leaves behind. The
 * frontend's syntax trees and program state refer to each other, so
 * reference counting frees almost none of them when the frontend is
 * disposed, and the collector's schedule alone may not run a full pass
 * before the build ends. */
void scriptc_native_collect_cycles(void) {
  scr_collect_cycles_phase();
}
