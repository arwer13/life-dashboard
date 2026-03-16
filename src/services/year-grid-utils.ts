export type YearSlot = { date: Date; key: string } | null;

export const MONTH_ABBREVIATIONS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
];

export function toDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function buildYearWeeks(year: number, weekStartsOn: number): YearSlot[][] {
  const weeks: YearSlot[][] = [];
  let currentDate = new Date(year, 0, 1);
  const yearEnd = new Date(year + 1, 0, 1);

  const firstDayOfWeek = (currentDate.getDay() - weekStartsOn + 7) % 7;
  let currentWeek: YearSlot[] = Array.from(
    { length: firstDayOfWeek },
    () => null
  );

  while (currentDate < yearEnd) {
    const dayOfWeek = (currentDate.getDay() - weekStartsOn + 7) % 7;
    if (dayOfWeek === 0 && currentWeek.length > 0) {
      while (currentWeek.length < 7) currentWeek.push(null);
      weeks.push(currentWeek);
      currentWeek = [];
    }
    currentWeek.push({
      date: new Date(currentDate),
      key: toDateKey(currentDate)
    });
    currentDate = new Date(
      currentDate.getFullYear(),
      currentDate.getMonth(),
      currentDate.getDate() + 1
    );
  }

  if (currentWeek.length > 0) {
    while (currentWeek.length < 7) currentWeek.push(null);
    weeks.push(currentWeek);
  }

  return weeks;
}

export function getMonthStartWeekIndex(weeks: YearSlot[][]): Map<number, number> {
  const result = new Map<number, number>();
  for (let w = 0; w < weeks.length; w++) {
    for (const slot of weeks[w]) {
      if (slot && slot.date.getDate() === 1) {
        result.set(slot.date.getMonth(), w);
        break;
      }
    }
  }
  return result;
}
