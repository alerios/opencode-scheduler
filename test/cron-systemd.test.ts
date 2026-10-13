import { describe, expect, test } from "bun:test"
import { cronToSystemdCalendars } from "../src/index"

describe("cronToSystemdCalendars", () => {
  test("omits the wildcard weekday token when the schedule has no weekday restriction", () => {
    const calendars = cronToSystemdCalendars("*/2 * * * *")
    expect(calendars.length).toBeGreaterThan(0)
    expect(calendars.every((c) => !c.startsWith("* "))).toBe(true)
  })

  test("keeps the weekday name when the schedule restricts day of week", () => {
    expect(cronToSystemdCalendars("30 10 * * 1")).toEqual(["Mon *-*-* 10:30:00"])
  })

  test("fully wildcarded schedule has no leading weekday token", () => {
    expect(cronToSystemdCalendars("* * * * *")).toEqual(["*-*-* *:*:00"])
  })
})
