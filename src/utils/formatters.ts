export function formatPhone(phone: string): string {
  const cleaned = phone.replace(/\D/g, '');
  
  if (cleaned.startsWith('51') && cleaned.length === 11) {
    const number = cleaned.substring(2);
    return `+51 ${number.substring(0, 3)} ${number.substring(3, 6)} ${number.substring(6)}`;
  }
  
  return phone;
}

export function formatDateTime(date: Date): string {
  return new Intl.DateTimeFormat('es-PE', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Lima',
  }).format(date);
}

export function replaceVariables(text: string, variables: Record<string, string>): string {
  let result = text;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replace(new RegExp(`{{${key}}}`, 'g'), value);
  }
  return result;
}