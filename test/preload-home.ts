import { dlopen, FFIType } from "bun:ffi"
import { mkdtempSync } from "fs"
import { tmpdir, platform } from "os"
import { join } from "path"

// Bun's `os.homedir()` calls libuv's uv_os_homedir(), which reads the
// process's real environ via getenv("HOME") — it ignores plain
// `process.env.HOME = x` assignments because Bun does not sync those back to
// the native environment. To make tests (and any module-level `homedir()`
// calls in the plugin) ever see a test HOME, we call the platform's libc
// setenv() directly via FFI. This patches `process.env.HOME` itself so every
// later plain assignment (e.g. inside a test's beforeAll) keeps working the
// same way, without each call site needing to know about FFI.
//
// The shared library that exports a POSIX setenv() differs per platform:
// glibc on Linux, libSystem on macOS. Windows has no POSIX setenv() at all
// (its CRT uses _putenv_s instead, and Bun's own os.homedir() on Windows
// reads USERPROFILE, not HOME) — rather than add an untested _putenv_s FFI
// binding for a test-only shim, we fail loudly and immediately with an
// actionable message instead of a cryptic dlopen error, so `bun test` on
// Windows tells a contributor exactly what's missing instead of polluting
// the real home directory or failing opaquely.
function resolveLibcPath(): string {
  switch (platform()) {
    case "linux":
      return "libc.so.6"
    case "darwin":
      return "libSystem.B.dylib"
    default:
      throw new Error(
        `test/preload-home.ts: no setenv() FFI binding for platform "${platform()}". ` +
          `This test suite isolates HOME via a native setenv() call (Bun does not sync ` +
          `process.env writes to the real environment, and os.homedir() reads the real ` +
          `one), which is only wired up for Linux (glibc) and macOS (libSystem) so far. ` +
          `Add a binding for this platform's CRT (e.g. _putenv_s via msvcrt.dll on ` +
          `Windows) before running tests here, to avoid writing into the real home ` +
          `directory.`,
      )
  }
}

const libc = dlopen(resolveLibcPath(), {
  setenv: { args: [FFIType.cstring, FFIType.cstring, FFIType.i32], returns: FFIType.i32 },
})

const realSetenv = (name: string, value: string) => libc.symbols.setenv(Buffer.from(`${name}\0`), Buffer.from(`${value}\0`), 1)

let currentHome = process.env.HOME ?? ""
Object.defineProperty(process.env, "HOME", {
  configurable: true,
  enumerable: true,
  get() {
    return currentHome
  },
  set(value: string) {
    currentHome = value
    realSetenv("HOME", value)
  },
})

// Isolate the default HOME for this whole test run immediately, before any
// module (including src/index.ts, which computes config paths at import
// time) can read the real one.
process.env.HOME = mkdtempSync(join(tmpdir(), "sched-test-home-"))
