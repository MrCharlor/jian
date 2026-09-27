/*
 * jian-sandbox: runs one program confined by Landlock to the paths it is given.
 *
 *   jian-sandbox --abi
 *   jian-sandbox [--ro PATH]... [--rw PATH]... -- PROGRAM [ARG]...
 *
 * `--abi` prints the Landlock ABI this kernel offers, 0 when it offers none, so the gateway can
 * decide once whether confinement is available. Otherwise the program runs with read and
 * execute beneath every `--ro` path, full access beneath every `--rw` path, and nothing
 * anywhere else. A path that does not exist is skipped: one list serves amd64 and arm64.
 *
 * Landlock needs no privilege, no namespace and no capability, which is why it works in a
 * container started with no-new-privileges and the runtime's default seccomp profile, where
 * user namespaces (bubblewrap, unshare) are refused. The restriction is the kernel's: the
 * program cannot lift it, and every process it starts inherits it. Landlock also denies ptrace
 * of any process outside the domain, which closes /proc/<gateway>/environ and friends.
 *
 * It fails closed: when the kernel refuses any step, the program is not run.
 *
 * No kernel headers are needed: the ABI below is stable, and bookworm's headers predate the
 * newer access rights.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

/* The same numbers on every architecture: they were allocated after the tables were unified. */
#ifndef SYS_landlock_create_ruleset
#define SYS_landlock_create_ruleset 444
#endif
#ifndef SYS_landlock_add_rule
#define SYS_landlock_add_rule 445
#endif
#ifndef SYS_landlock_restrict_self
#define SYS_landlock_restrict_self 446
#endif

#define CREATE_RULESET_VERSION (1U << 0)
#define RULE_PATH_BENEATH 1

#define FS_EXECUTE (1ULL << 0)
#define FS_WRITE_FILE (1ULL << 1)
#define FS_READ_FILE (1ULL << 2)
#define FS_READ_DIR (1ULL << 3)
#define FS_REMOVE_DIR (1ULL << 4)
#define FS_REMOVE_FILE (1ULL << 5)
#define FS_MAKE_CHAR (1ULL << 6)
#define FS_MAKE_DIR (1ULL << 7)
#define FS_MAKE_REG (1ULL << 8)
#define FS_MAKE_SOCK (1ULL << 9)
#define FS_MAKE_FIFO (1ULL << 10)
#define FS_MAKE_BLOCK (1ULL << 11)
#define FS_MAKE_SYM (1ULL << 12)
#define FS_REFER (1ULL << 13)    /* ABI 2 */
#define FS_TRUNCATE (1ULL << 14) /* ABI 3 */
#define FS_IOCTL_DEV (1ULL << 15) /* ABI 5 */

#define SCOPE_ABSTRACT_UNIX_SOCKET (1ULL << 0) /* ABI 6 */
#define SCOPE_SIGNAL (1ULL << 1)               /* ABI 6 */

/* Rights that make sense on a file, as opposed to a directory. */
#define FS_FILE_RIGHTS (FS_EXECUTE | FS_WRITE_FILE | FS_READ_FILE | FS_TRUNCATE | FS_IOCTL_DEV)
#define FS_READ_RIGHTS (FS_EXECUTE | FS_READ_FILE | FS_READ_DIR)

struct ruleset_attr {
  uint64_t handled_access_fs;
  uint64_t handled_access_net;
  uint64_t scoped;
};

struct path_beneath_attr {
  uint64_t allowed_access;
  int32_t parent_fd;
} __attribute__((packed));

static int abi(void) {
  long version = syscall(SYS_landlock_create_ruleset, NULL, 0, CREATE_RULESET_VERSION);

  return version < 0 ? 0 : (int)version;
}

/* Every filesystem right this kernel knows, so none is left unrestricted by omission. */
static uint64_t handled_fs(int version) {
  uint64_t rights = FS_EXECUTE | FS_WRITE_FILE | FS_READ_FILE | FS_READ_DIR | FS_REMOVE_DIR |
                    FS_REMOVE_FILE | FS_MAKE_CHAR | FS_MAKE_DIR | FS_MAKE_REG | FS_MAKE_SOCK |
                    FS_MAKE_FIFO | FS_MAKE_BLOCK | FS_MAKE_SYM;

  if (version >= 2) rights |= FS_REFER;
  if (version >= 3) rights |= FS_TRUNCATE;
  if (version >= 5) rights |= FS_IOCTL_DEV;

  return rights;
}

static int allow(int ruleset, const char *path, uint64_t rights) {
  int fd = open(path, O_PATH | O_CLOEXEC);

  if (fd < 0) {
    if (errno == ENOENT || errno == ENOTDIR) return 0;
    fprintf(stderr, "jian-sandbox: %s: %s\n", path, strerror(errno));
    return -1;
  }

  struct stat info;

  if (fstat(fd, &info) < 0) {
    fprintf(stderr, "jian-sandbox: %s: %s\n", path, strerror(errno));
    close(fd);
    return -1;
  }

  /* The kernel rejects directory rights on a file. */
  if (!S_ISDIR(info.st_mode)) rights &= FS_FILE_RIGHTS;

  struct path_beneath_attr rule = {.allowed_access = rights, .parent_fd = fd};
  long added = syscall(SYS_landlock_add_rule, ruleset, RULE_PATH_BENEATH, &rule, 0);
  int saved = errno;

  close(fd);

  if (added < 0) {
    fprintf(stderr, "jian-sandbox: %s: %s\n", path, strerror(saved));
    return -1;
  }

  return 0;
}

static int usage(void) {
  fputs("usage: jian-sandbox --abi\n"
        "       jian-sandbox [--ro PATH]... [--rw PATH]... -- PROGRAM [ARG]...\n",
        stderr);
  return 125;
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--abi") == 0) {
    printf("%d\n", abi());
    return 0;
  }

  int version = abi();

  if (version < 1) {
    fputs("jian-sandbox: this kernel does not offer Landlock; refusing to run unconfined\n",
          stderr);
    return 125;
  }

  uint64_t handled = handled_fs(version);
  struct ruleset_attr attr = {.handled_access_fs = handled};

  /* Signals and abstract Unix sockets stay within the sandbox from ABI 6 (Linux 6.12). */
  if (version >= 6) attr.scoped = SCOPE_ABSTRACT_UNIX_SOCKET | SCOPE_SIGNAL;

  /* An older kernel reads only the fields it knows; the rest must be zero, and are. */
  int ruleset = (int)syscall(SYS_landlock_create_ruleset, &attr, sizeof(attr), 0);

  if (ruleset < 0) {
    fprintf(stderr, "jian-sandbox: landlock_create_ruleset: %s\n", strerror(errno));
    return 125;
  }

  int index = 1;

  for (; index < argc; index += 2) {
    if (strcmp(argv[index], "--") == 0) break;
    if (index + 1 >= argc) return usage();

    if (strcmp(argv[index], "--ro") == 0) {
      if (allow(ruleset, argv[index + 1], FS_READ_RIGHTS & handled) < 0) return 125;
    } else if (strcmp(argv[index], "--rw") == 0) {
      if (allow(ruleset, argv[index + 1], handled) < 0) return 125;
    } else {
      return usage();
    }
  }

  if (index >= argc - 1) return usage();

  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0 ||
      syscall(SYS_landlock_restrict_self, ruleset, 0) < 0) {
    fprintf(stderr, "jian-sandbox: landlock_restrict_self: %s\n", strerror(errno));
    return 125;
  }

  close(ruleset);
  execvp(argv[index + 1], &argv[index + 1]);
  fprintf(stderr, "jian-sandbox: %s: %s\n", argv[index + 1], strerror(errno));
  return 127;
}
