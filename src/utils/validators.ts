// src/utils/validators.ts

/** =========================
 *  Helpers generales
 *  ========================= */
export function digitsOnly(v: string): string {
  return String(v ?? '').replace(/\D/g, '');
}

export function isValidDNI(dni: string): boolean {
  return /^\d{8}$/.test((dni || '').trim());
}

export function isValidRUC(ruc: string): boolean {
  return /^\d{11}$/.test((ruc || '').trim());
}

/** ITU-T E.164: 8..15 dígitos, sin '+' */
export function isValidPhoneE164(e164: string): boolean {
  const d = digitsOnly(e164);
  return d.length >= 8 && d.length <= 15;
}

/** =========================
 *  País por defecto y reglas
 *  ========================= */
/**
 * País por defecto cuando NO viene código.
 * Ej.: "51" (Perú) / "57" (Colombia) / "54" (Argentina)
 */
function defaultCountryCode(): string {
  return (process.env.DEFAULT_CC || '51').replace(/\D/g, '');
}

/**
 * Algunas reglas por país (muy básicas) para números locales.
 * - Permiten limpiar el 0 "trunk" inicial.
 * - Chequean longitudes típicas para móviles locales.
 * No pretende reemplazar libphonenumber.
 */
const COUNTRY_RULES: Record<
  string,
  { localLengths: number[]; stripTrunk0?: boolean }
> = {
  // Perú
  '51': { localLengths: [9], stripTrunk0: false }, // móviles 9 dígitos (empiezan con 9)
  // Colombia
  '57': { localLengths: [10], stripTrunk0: true }, // muchos escriben 0XXXXXXXXXX
  // Argentina
  '54': { localLengths: [10], stripTrunk0: true },
  // México
  '52': { localLengths: [10], stripTrunk0: true },
  // Chile
  '56': { localLengths: [9], stripTrunk0: true },
  // España
  '34': { localLengths: [9], stripTrunk0: false },
  // Ecuador
  '593': { localLengths: [9], stripTrunk0: true },
  // Bolivia
  '591': { localLengths: [8], stripTrunk0: true },
  // Paraguay
  '595': { localLengths: [9], stripTrunk0: true },
  // Uruguay
  '598': { localLengths: [8, 9], stripTrunk0: true },
};

/** Lista de prefijos de país que reconocemos sin ambigüedad (los más usados en tu operación) */
const KNOWN_CCS = Object.keys(COUNTRY_RULES).sort((a, b) => b.length - a.length); // ordena por largo desc para maches tipo 593 antes que 59

/** Quita prefijos internacionales "00"/"011" si los usaron al marcar */
function stripIddPrefix(d: string): string {
  if (d.startsWith('00')) return d.slice(2);
  if (d.startsWith('011')) return d.slice(3);
  return d;
}

/** Si el número local trae un 0 de trunk, lo removemos si la regla del país lo indica */
function stripTrunkZeroIfNeeded(local: string, cc: string): string {
  const rule = COUNTRY_RULES[cc];
  if (!rule?.stripTrunk0) return local;
  if (local.startsWith('0') && local.length > 1) return local.slice(1);
  return local;
}

/**
 * Normaliza a **E.164 (sin '+')**
 *
 * Entradas soportadas:
 * - "+51987654321", "0051987654321", "01151987654321"
 * - "51987654321" (ya e164)
 * - "987654321" (local) → usa DEFAULT_CC
 * - "057300000000" (local con trunk 0) → "57300000000"
 *
 * Siempre retorna solo dígitos. Lanza Error con mensaje claro si no puede normalizar.
 */
export function normalizePhone(raw: string): string {
  if (!raw) throw new Error('Número vacío');
  let d = digitsOnly(raw);
  if (!d) throw new Error(`Número inválido: "${raw}"`);

  // 1) Quitar prefijos internacionales comunes
  d = stripIddPrefix(d);

  // 2) Si ya parece E.164 con un CC conocido, respetarlo
  for (const cc of KNOWN_CCS) {
    if (d.startsWith(cc)) {
      const local = d.slice(cc.length);
      const cleanedLocal = stripTrunkZeroIfNeeded(local, cc);
      const final = cc + cleanedLocal;
      if (!isValidPhoneE164(final)) {
        throw new Error(
          `Número inválido para país +${cc}: "${raw}" → "${final}"`
        );
      }
      return final;
    }
  }

  // 3) No coincide con CC conocido
  const defCC = defaultCountryCode();

  // Si tiene pinta de e164 (8–15 dígitos), lo aceptamos tal cual
  if (d.length >= 8 && d.length <= 15) {
    return d;
  }

  // 4) Tratar como local con DEFAULT_CC
  const rule = COUNTRY_RULES[defCC];
  let local = d;

  // Trunk 0 para default CC si aplica
  local = stripTrunkZeroIfNeeded(local, defCC);

  // Si hay longitudes locales definidas para el default CC, validarlas
  if (rule?.localLengths?.length) {
    if (!rule.localLengths.includes(local.length)) {
      // Aun así, si 8..15 con CC + local, permite — es más flexible
      const candidate = defCC + local;
      if (!isValidPhoneE164(candidate)) {
        throw new Error(
          `Número local inválido para +${defCC}. Longitud esperada: ${rule.localLengths.join(
            '/'
          )}; recibido: ${local.length}.`
        );
      }
      return candidate;
    }
  }

  const e164 = defCC + local;
  if (!isValidPhoneE164(e164)) {
    throw new Error(`Número inválido (E.164): "${raw}" → "${e164}"`);
  }
  return e164;
}

/** Construye el JID de WhatsApp a partir de E.164 (sin '+') */
export function formatJid(e164: string): string {
  const d = digitsOnly(e164);
  if (!isValidPhoneE164(d)) throw new Error(`E.164 inválido para JID: "${e164}"`);
  return `${d}@s.whatsapp.net`;
}

/** Extrae el E.164 (sin '+') desde un JID (remueve sufijos de dispositivo si existen) */
export function extractPhoneFromJid(jid: string): string {
  const left = (jid || '').split('@')[0];
  const base = left.split(':')[0];
  return digitsOnly(base);
}

/** ¿Es un JID de grupo? */
export function isGroupJid(jid: string): boolean {
  return !!jid && jid.endsWith('@g.us');
}

/** =========================
 *  Helpers extra para WhatsApp
 *  ========================= */

/**
 * Normaliza un remoteJid a solo dígitos.
 * Ej: "51924894792@s.whatsapp.net" → "51924894792"
 *     "51924894792:12@s.whatsapp.net" → "51924894792"
 */
export function normalizeJidToPhone(remoteJid: string): string {
  if (!remoteJid) return '';
  const leftSide = remoteJid.split('@')[0];
  const justNumber = leftSide.split(':')[0];
  return digitsOnly(justNumber);
}

/**
 * Valida de forma simple que el número "parezca" un teléfono real.
 * En tu caso asumes Perú (E.164 sin '+'): 51 + 9 dígitos = 11 caracteres.
 *
 * Ejemplo válido: 51994681222
 */
export function isLikelyRealPhone(
  phone: string | null | undefined
): boolean {
  const d = digitsOnly(phone ?? '');
  // Regla específica para Perú (DEFAULT_CC=51)
  return /^51\d{9}$/.test(d);
}
