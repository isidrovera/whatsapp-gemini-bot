// services/holidaySync.ts
import { logger } from '../utils/logger.js';
import * as systemVar from '../models/systemVar.js';
import * as calendar from '../models/calendar.js';

/** Tipado de la respuesta Nager.Date */
type NagerHoliday = { date: string; localName: string; name: string };

/** Valida formato YYYY-MM-DD */
function isValidYMD(ymd: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(ymd);
}

/**
 * Normaliza una fecha yyyy-mm-dd a Date UTC (00:00Z).
 */
function ymdToUTC(ymd: string): Date {
  return new Date(`${ymd}T00:00:00.000Z`);
}

/**
 * Inserta/actualiza en CalendarEvent evitando duplicados por (date,title,type).
 */
async function upsertHoliday(
  ymd: string,
  title: string,
  type: 'holiday' | 'closure' = 'holiday'
) {
  const date = ymdToUTC(ymd);
  // Usamos update con búsqueda previa (por fecha y título)
  const exists = await calendar.findByDateAndTitle(ymd, title);
  if (exists) return exists;
  return await calendar.create(title, ymd, type, undefined, true);
}

/* ==============================
 * Fuente A: Nager.Date (sin API key)
 * GET https://date.nager.at/api/v3/PublicHolidays/{year}/PE
 * ============================== */
export async function syncFromNager(year: number) {
  const url = `https://date.nager.at/api/v3/PublicHolidays/${year}/PE`;
  logger.info(`[HOLIDAYS] Fetching Nager.Date for ${year} -> ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Nager.Date error ${res.status}`);

  // Corrección: res.json() es unknown en TS estricto -> casteamos al tipo esperado
  const data = (await res.json()) as NagerHoliday[];

  let created = 0;
  for (const h of data) {
    const title = (h.localName || h.name || '').trim();
    const ymd = String(h.date || '').trim(); // esperado YYYY-MM-DD (UTC)
    if (!title || !isValidYMD(ymd)) continue;

    const existed = await calendar.findByDateAndTitle(ymd, title);
    if (!existed) {
      await upsertHoliday(ymd, title, 'holiday');
      created++;
    }
  }
  logger.info(`[HOLIDAYS] Nager.Date ${year}: ${created} nuevos feriados.`);
  return created;
}

/* ======================================
 * Fuente B: Google Calendar ICS (Peru)
 * Pega la URL ICS de “Holidays in Peru”
 * ====================================== */
function parseICS(icsText: string): Array<{ ymd: string; title: string }> {
  // Parser simple para all-day events
  // Busca líneas DTSTART;VALUE=DATE:YYYYMMDD y SUMMARY:...
  const lines = icsText.split(/\r?\n/);
  const out: Array<{ ymd: string; title: string }> = [];
  let current: { ymd?: string; title?: string } = {};
  for (const line of lines) {
    if (line.startsWith('BEGIN:VEVENT')) {
      current = {};
    } else if (line.startsWith('DTSTART;VALUE=DATE:')) {
      const raw = line.split(':')[1]?.trim(); // YYYYMMDD
      if (raw && raw.length === 8) {
        const y = raw.slice(0, 4);
        const m = raw.slice(4, 6);
        const d = raw.slice(6, 8);
        current.ymd = `${y}-${m}-${d}`;
      }
    } else if (line.startsWith('SUMMARY:')) {
      current.title = line.slice(8).trim();
    } else if (line.startsWith('END:VEVENT')) {
      if (current.ymd && current.title && isValidYMD(current.ymd)) {
        out.push({ ymd: current.ymd, title: current.title });
      }
    }
  }
  return out;
}

export async function syncFromICS(icsUrl: string) {
  logger.info(`[HOLIDAYS] Fetching ICS -> ${icsUrl}`);
  const res = await fetch(icsUrl);
  if (!res.ok) throw new Error(`ICS error ${res.status}`);
  const text = await res.text();
  const entries = parseICS(text);

  let created = 0;
  for (const e of entries) {
    const existed = await calendar.findByDateAndTitle(e.ymd, e.title);
    if (!existed) {
      await upsertHoliday(e.ymd, e.title, 'holiday');
      created++;
    }
  }
  logger.info(`[HOLIDAYS] ICS: ${created} nuevos feriados.`);
  return created;
}

/* ======================================
 * Job principal: toma fuente de SystemVariable
 *   holiday_source: "nager" | "ics"
 *   holiday_ics_url: URL pública de ICS (si source=ics)
 *   holiday_years_back: cuántos años hacia atrás (default 0)
 *   holiday_years_ahead: cuántos años hacia adelante (default 1)
 * ====================================== */
export async function syncPublicHolidays() {
  const source = (await systemVar.get('holiday_source')) || 'nager';
  const yearsBack = Number((await systemVar.get('holiday_years_back')) ?? '0') || 0;
  const yearsAhead = Number((await systemVar.get('holiday_years_ahead')) ?? '1') || 1;

  const currentYear = new Date().getFullYear();
  let total = 0;

  if (source === 'ics') {
    const icsUrl = await systemVar.get('holiday_ics_url');
    if (!icsUrl) {
      logger.warn('[HOLIDAYS] holiday_source=ics pero falta system_variables.holiday_ics_url');
      return 0;
    }
    total += await syncFromICS(icsUrl);
  } else {
    for (let y = currentYear - yearsBack; y <= currentYear + yearsAhead; y++) {
      total += await syncFromNager(y);
    }
  }

  logger.info(`[HOLIDAYS] Sincronización completa. Feriados nuevos: ${total}.`);
  return total;
}
