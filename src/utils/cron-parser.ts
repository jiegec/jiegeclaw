const FIELD_MAX = [59, 23, 31, 12, 6];

export function parseSchedule(expr: string): string | undefined {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return undefined;
  for (const field of fields) {
    if (!isValidCronField(field)) return undefined;
  }
  return fields.join(" ");
}

function isValidCronField(field: string): boolean {
  if (field === "*") return true;
  if (/^\d+$/.test(field)) return true;
  if (/^\d+-\d+$/.test(field)) return true;
  if (/^\d+(,\d+)+$/.test(field)) return true;
  if (/^(?:\*|\d+(?:-\d+)?|\d+(?:,\d+)+)\/\d+$/.test(field)) return true;
  return false;
}

function matchesField(field: string, value: number, fieldIndex: number): boolean {
  const max = FIELD_MAX[fieldIndex];
  if (value < 0 || value > max) return false;
  if (field === "*") return true;

  const stepMatch = field.match(/^(.+?)\/(\d+)$/);
  if (stepMatch) {
    const base = stepMatch[1];
    const step = parseInt(stepMatch[2], 10);
    if (!matchesField(base, value, fieldIndex)) return false;
    const baseValues = expandField(base, max);
    return baseValues.some((v) => v <= value && (value - v) % step === 0);
  }

  if (field.includes(",")) {
    return field.split(",").some((part) => matchesField(part.trim(), value, fieldIndex));
  }

  const rangeMatch = field.match(/^(\d+)-(\d+)$/);
  if (rangeMatch) {
    const start = parseInt(rangeMatch[1], 10);
    const end = parseInt(rangeMatch[2], 10);
    return value >= start && value <= end;
  }

  return value === parseInt(field, 10);
}

function expandField(field: string, max: number): number[] {
  if (field === "*") return Array.from({ length: max + 1 }, (_, i) => i);
  if (field.includes(",")) {
    return field.split(",").flatMap((part) => expandField(part.trim(), max));
  }
  const rangeMatch = field.match(/^(\d+)-(\d+)$/);
  if (rangeMatch) {
    const start = parseInt(rangeMatch[1], 10);
    const end = parseInt(rangeMatch[2], 10);
    const values: number[] = [];
    for (let i = start; i <= end; i++) values.push(i);
    return values;
  }
  return [parseInt(field, 10)];
}

export function nextCronMs(fields: string[], now: Date): number {
  const candidates: Date[] = [];

  for (let dayOffset = 0; dayOffset <= 366; dayOffset++) {
    const d = new Date(now);
    d.setDate(d.getDate() + dayOffset);
    d.setSeconds(0, 0);

    if (!matchesField(fields[2], d.getDate(), 2)) continue;
    if (!matchesField(fields[3], d.getMonth() + 1, 3)) continue;
    if (!matchesField(fields[4], d.getDay(), 4)) continue;

    for (let h = 0; h <= 23; h++) {
      if (!matchesField(fields[1], h, 1)) continue;
      if (dayOffset === 0 && h < now.getHours()) continue;

      for (let m = 0; m <= 59; m++) {
        if (!matchesField(fields[0], m, 0)) continue;
        if (dayOffset === 0 && h === now.getHours() && m <= now.getMinutes()) continue;

        const candidate = new Date(d);
        candidate.setHours(h, m, 0, 0);
        candidates.push(candidate);
        break;
      }

      if (candidates.length > 0 && dayOffset === 0 && h === now.getHours()) break;
      if (candidates.length > 0) break;
    }

    if (candidates.length > 0) break;
  }

  if (candidates.length === 0) return 60000;
  return candidates[0].getTime() - Date.now();
}
