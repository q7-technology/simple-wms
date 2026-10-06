import { addDays, goalStreak, suggestGoal, usualPerDay, warehouseDay, type ShippedRow } from "../lib/goal";

const TODAY = "2026-10-06";
const day = (n: number) => addDays(TODAY, n);

describe("today's goal suggestion", () => {
  it("is the usual per shipping day, a tenth more, up to the next five", () => {
    // 40 a day on four shipping days: 44 is a tenth more, 45 is the next five
    const rows: ShippedRow[] = [-1, -2, -3, -4].map((n) => ({ day: day(n), deliveries: 40 }));
    expect(usualPerDay(rows, TODAY)).toBe(40);
    expect(suggestGoal(rows, TODAY)).toBe(45);
  });

  it("does not round 55 up to 60 because of floating point", () => {
    const rows: ShippedRow[] = [{ day: day(-1), deliveries: 50 }];
    expect(suggestGoal(rows, TODAY)).toBe(55);
  });

  it("averages over days that shipped, not over the calendar", () => {
    // one busy day and a weekend of nothing is still a 20-a-day warehouse
    const rows: ShippedRow[] = [
      { day: day(-1), deliveries: 20 }, { day: day(-2), deliveries: 0 }, { day: day(-3), deliveries: 0 },
    ];
    expect(usualPerDay(rows, TODAY)).toBe(20);
    expect(suggestGoal(rows, TODAY)).toBe(25);
  });

  it("leaves out today and anything older than 28 days", () => {
    const rows: ShippedRow[] = [
      { day: TODAY, deliveries: 500 },
      { day: day(-29), deliveries: 500 },
      { day: day(-28), deliveries: 10 },
    ];
    expect(usualPerDay(rows, TODAY)).toBe(10);
    expect(suggestGoal(rows, TODAY)).toBe(15);
  });

  it("never suggests less than five, even with no history", () => {
    expect(suggestGoal([], TODAY)).toBe(5);
    expect(usualPerDay([], TODAY)).toBeNull();
    expect(suggestGoal([{ day: day(-1), deliveries: 1 }], TODAY)).toBe(5);
  });
});

describe("goal streak", () => {
  const rows: ShippedRow[] = [
    { day: day(-1), deliveries: 50 },
    { day: day(-2), deliveries: 46 },
    // a closed day in between neither breaks nor counts
    { day: day(-4), deliveries: 45 },
    { day: day(-5), deliveries: 30 },
    { day: day(-6), deliveries: 60 },
  ];

  it("counts shipping days in a row that reached the goal", () => {
    expect(goalStreak(rows, TODAY, 45)).toBe(3);
  });

  it("adds today once today is reached, and does not break before then", () => {
    expect(goalStreak([...rows, { day: TODAY, deliveries: 10 }], TODAY, 45)).toBe(3);
    expect(goalStreak([...rows, { day: TODAY, deliveries: 45 }], TODAY, 45)).toBe(4);
  });

  it("is zero when yesterday fell short", () => {
    expect(goalStreak([{ day: day(-1), deliveries: 3 }, { day: day(-2), deliveries: 90 }], TODAY, 45)).toBe(0);
  });
});

describe("the warehouse's own date", () => {
  it("reads the date on the warehouse's clock", () => {
    // 13:30 UTC on 5 Oct is half past midnight on the 6th in Melbourne
    // (summer time, +11) and still the morning of the 5th in Honolulu.
    const at = new Date("2026-10-05T13:30:00Z");
    expect(warehouseDay("Australia/Melbourne", at)).toBe("2026-10-06");
    expect(warehouseDay("Pacific/Honolulu", at)).toBe("2026-10-05");
  });

  it("moves plain dates by whole days across a month", () => {
    expect(addDays("2026-10-01", -1)).toBe("2026-09-30");
    expect(addDays("2026-09-30", 28)).toBe("2026-10-28");
  });
});
