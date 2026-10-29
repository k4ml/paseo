import { describe, expect, test, vi } from "vitest";

import { mergePathEntries, resolveLoginShellPath } from "./login-shell-env.js";

describe("mergePathEntries", () => {
  test("keeps the dev PATH first and appends entries only the login shell has", () => {
    expect(mergePathEntries("/dev/bin:/usr/bin", "/usr/bin:/home/me/.opencode/bin")).toBe(
      "/dev/bin:/usr/bin:/home/me/.opencode/bin",
    );
  });

  test("drops empty entries", () => {
    expect(mergePathEntries("/a::/b", ":")).toBe("/a:/b");
  });

  test("returns whichever side is present", () => {
    expect(mergePathEntries(undefined, "/login/bin")).toBe("/login/bin");
    expect(mergePathEntries("/dev/bin", undefined)).toBe("/dev/bin");
    expect(mergePathEntries(undefined, undefined)).toBeUndefined();
  });
});

describe("resolveLoginShellPath", () => {
  test("reads the last PATH line printed by the login shell", () => {
    const spawn = vi.fn().mockReturnValue({ status: 0, stdout: "greeting\nFOO=1\nPATH=/a:/b\n" });

    expect(
      resolveLoginShellPath({
        env: { SHELL: "/usr/bin/fish" },
        platform: "linux",
        spawn: spawn as never,
      }),
    ).toBe("/a:/b");
    expect(spawn).toHaveBeenCalledWith(
      "/usr/bin/fish",
      ["-l", "-i", "-c", "env"],
      expect.objectContaining({ encoding: "utf8" }),
    );
  });

  test("falls back to a non-interactive login shell", () => {
    const spawn = vi
      .fn()
      .mockReturnValueOnce({ status: 1, stdout: "" })
      .mockReturnValueOnce({ status: 0, stdout: "PATH=/fallback/bin\n" });

    expect(
      resolveLoginShellPath({
        env: { SHELL: "/bin/bash" },
        platform: "linux",
        spawn: spawn as never,
      }),
    ).toBe("/fallback/bin");
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  test("returns null without a shell or on Windows", () => {
    expect(resolveLoginShellPath({ env: {}, platform: "linux" })).toBeNull();
    expect(resolveLoginShellPath({ env: { SHELL: "/bin/bash" }, platform: "win32" })).toBeNull();
  });

  test("treats a throwing or failing shell as unresolved, not as an absent PATH", () => {
    const throwing = vi.fn().mockImplementation(() => {
      throw new Error("spawnSync ETIMEDOUT");
    });
    const empty = vi.fn().mockReturnValue({ status: 0, stdout: "NO_PATH_HERE\n" });

    expect(
      resolveLoginShellPath({
        env: { SHELL: "/bin/zsh" },
        platform: "linux",
        spawn: throwing as never,
      }),
    ).toBeNull();
    expect(
      resolveLoginShellPath({
        env: { SHELL: "/bin/zsh" },
        platform: "linux",
        spawn: empty as never,
      }),
    ).toBeNull();
  });
});
