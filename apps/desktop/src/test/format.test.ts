import { fmtQty, fmtDate, fmtWhen, initials, setDisplayZone, zoneNote } from "../lib/format";

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

describe("the warehouse's own clock", () => {
  afterEach(() => setDisplayZone(null));

  it("shows times on the warehouse's clock, not the reader's", () => {
    // 09:30 in Perth on a winter morning. Whatever zone this machine is set
    // to, a reader looking at Perth stock should read half past nine.
    const at = "2026-07-15T01:30:00Z";
    setDisplayZone("Australia/Perth");
    expect(fmtWhen(at, new Date("2026-07-15T02:00:00Z"))).toBe("09:30");
    setDisplayZone("Australia/Melbourne");
    expect(fmtWhen(at, new Date("2026-07-15T02:00:00Z"))).toBe("11:30");
    setDisplayZone("UTC");
    expect(fmtWhen(at, new Date("2026-07-15T02:00:00Z"))).toBe("01:30");
  });

  it("decides what counts as today on the warehouse's clock too", () => {
    // 23:00 Wednesday in Perth is already Thursday in Melbourne. Asked on
    // Perth's Thursday morning, Perth says a weekday and Melbourne a time.
    const at = "2026-07-15T15:00:00Z";
    const now = new Date("2026-07-16T02:00:00Z");
    setDisplayZone("Australia/Perth");
    expect(fmtWhen(at, now)).toBe("Wed");
    setDisplayZone("Australia/Melbourne");
    expect(fmtWhen(at, now)).toBe("01:00");
  });

  it("falls back to the reader's own clock when no zone is set", () => {
    const now = new Date(2026, 6, 15, 10, 0, 0);
    const anHourAgo = new Date(now.getTime() - 3600_000);
    setDisplayZone(null);
    expect(fmtWhen(anHourAgo.toISOString(), now)).toBe(anHourAgo.toTimeString().slice(0, 5));
  });

  it("ignores a zone name it cannot read rather than throwing", () => {
    const now = new Date(2026, 6, 15, 10, 0, 0);
    setDisplayZone("Mars/Olympus_Mons");
    expect(fmtWhen(now.toISOString(), now)).toBe(now.toTimeString().slice(0, 5));
  });

  it("names the zone only when it is not the reader's own", () => {
    const at = new Date("2026-07-15T02:00:00Z");
    expect(zoneNote(null, at)).toBeNull();
    expect(zoneNote(Intl.DateTimeFormat().resolvedOptions().timeZone, at)).toBeNull();
    const elsewhere = Intl.DateTimeFormat().resolvedOptions().timeZone === "Pacific/Kiritimati"
      ? "Australia/Perth" : "Pacific/Kiritimati";
    expect(zoneNote(elsewhere, at)).not.toBeNull();
  });

  it("gives the zone's short name and its time of day", () => {
    const note = zoneNote("Australia/Perth", new Date("2026-07-15T02:00:00Z"),
                          "Australia/Melbourne");
    expect(note).toEqual({ label: "AWST", time: "10:00" });
  });
});
