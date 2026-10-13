import { dlopen, FFIType } from "bun:ffi"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// Bun's `os.homedir()` calls libuv's uv_os_homedir(), which reads the
// process's real environ via getenv("HOME") — it ignores plain
// `process.env.HOME = x` assignments because Bun does not sync those back to
// the native environment. To make tests (and any module-level `homedir()`
// calls in the plugin) ever see a test HOME, we call libc's setenv()
// directly via FFI. This patches `process.env.HOME` itself so every later
// plain assignment (e.g. inside a test's beforeAll) keeps working the same
// way, without each call site needing to know about FFI.
const libc = dlopen("libc.so.6", {
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
