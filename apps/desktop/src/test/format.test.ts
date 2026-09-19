import { fmtQty, fmtDate, fmtWhen, initials } from "../lib/format";

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
    const now = new Date("2026-09-19T10:00:00+10:00"); // Saturday
    expect(fmtWhen("2026-09-19T09:14:00+10:00", now)).toBe("09:14");
    expect(fmtWhen("2026-09-18T09:14:00+10:00", now)).toBe("Fri");
    expect(fmtWhen("2026-08-30T09:14:00+10:00", now)).toBe("30 Aug");
  });
});

describe("initials", () => {
  it("takes the first letters of up to two words", () => {
    expect(initials("Leighton Lauton")).toBe("LL");
    expect(initials("Sam")).toBe("S");
    expect(initials("Priya N. Kumar")).toBe("PN");
  });
});
