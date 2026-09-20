import { fmtQty, fmtDate, fmtWhen, initials } from "../lib/format";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

describe("fmtQty", () => {
  it("groups thousands and keeps decimals as sent", () => {
    expect(fmtQty("4200")).toBe("4,200");
    expect(fmtQty("38.5")).toBe("38.5");
    expect(fmtQty("0")).toBe("0");
    expect(fmtQty("-2")).toBe("−2");
  });
  it("shows a unit when given", () => {
    expect(fmtQty("168", "EA")).toBe("168 EA");
  });
});

describe("dates", () => {
  it("formats a day without the year when it is this year", () => {
    expect(fmtDate("2026-08-30", new Date("2026-09-19T00:00:00Z"))).toBe("30 Aug");
    expect(fmtDate("2025-08-30", new Date("2026-09-19T00:00:00Z"))).toBe("30 Aug 2025");
    expect(fmtDate(null)).toBe("—");
  });
  it("shows a time for today, a weekday this week, otherwise the date", () => {
    // Timestamps are shown in the reader's own timezone, so the test builds
    // its moments relative to now rather than pinning an offset. Otherwise it
    // only passes on a machine set to the offset it was written on.
    // 10 am on a Saturday in whatever zone this machine runs in, so "an hour
    // ago" is safely the same day everywhere.
    const now = new Date(2026, 8, 19, 10, 0, 0);
    const hoursBefore = (n: number) => new Date(now.getTime() - n * 3600_000).toISOString();
    const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

    const anHourAgo = new Date(now.getTime() - 3600_000);
    expect(fmtWhen(anHourAgo.toISOString(), now)).toBe(
      anHourAgo.toTimeString().slice(0, 5));

    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 3600_000);
    expect(fmtWhen(hoursBefore(48), now)).toBe(DAYS[twoDaysAgo.getDay()]);

    const longAgo = new Date(now.getTime() - 20 * 24 * 3600_000);
    expect(fmtWhen(longAgo.toISOString(), now)).toBe(
      `${longAgo.getDate()} ${MONTHS[longAgo.getMonth()]}`);

    expect(fmtWhen(null, now)).toBe("—");
  });
});

describe("initials", () => {
  it("takes the first letters of up to two words", () => {
    expect(initials("Leighton Lauton")).toBe("LL");
    expect(initials("Sam")).toBe("S");
    expect(initials("Priya N. Kumar")).toBe("PN");
  });
});
