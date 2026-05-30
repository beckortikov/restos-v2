// CP866 → UTF-8 хелпер для расшифровки ESC/POS hex-payload'ов, которые
// приходят с бэка в audit_log / print_jobs.contentHex. Используется ТОЛЬКО
// для UI-отображения текста в очереди печати / «зависшая печать» — никакая
// бизнес-логика на этом не строится. Раньше жил в lib/print-service.ts
// (legacy client-side ESC/POS-сборщик, Path A) — выпилен вместе с ним.

const CP866_MAP: Record<string, number> = {}
'АБВГДЕЖЗИЙКЛМНОП'.split('').forEach((c, i) => { CP866_MAP[c] = 0x80 + i })
'РСТУФХЦЧШЩЪЫЬЭЮЯ'.split('').forEach((c, i) => { CP866_MAP[c] = 0x90 + i })
'абвгдежзийклмноп'.split('').forEach((c, i) => { CP866_MAP[c] = 0xA0 + i })
'рстуфхцчшщъыьэюя'.split('').forEach((c, i) => { CP866_MAP[c] = 0xE0 + i })
CP866_MAP['Ё'] = 0xF0
CP866_MAP['ё'] = 0xF1
CP866_MAP['·'] = 0xFA
CP866_MAP['№'] = 0xFC
CP866_MAP['°'] = 0xF8
CP866_MAP['¤'] = 0xFD

const CP866_REVERSE: Record<number, string> = {}
for (const [ch, code] of Object.entries(CP866_MAP)) CP866_REVERSE[code] = ch

export function decodeCP866Hex(hex: string): string {
  if (!hex) return ''
  let out = ''
  let i = 0
  while (i < hex.length) {
    const byte = parseInt(hex.slice(i, i + 2), 16)
    if (Number.isNaN(byte)) break
    if (byte === 0x1B || byte === 0x1D) {
      // ESC (1B) / GS (1D) command — пропускаем 3 байта (opcode + 2 args).
      // Эвристика — без полноценного парсера команд, чтобы оставлять
      // только печатаемый текст для human-readable журнала.
      i += 6
      continue
    }
    if (byte === 0x0A) { out += '\n'; i += 2; continue } // LF
    if (byte === 0x0D) { i += 2; continue } // CR — ignore
    if (byte === 0x09) { out += '\t'; i += 2; continue }
    if (byte === 0x00) { i += 2; continue }
    if (byte < 0x80) {
      out += String.fromCharCode(byte)
    } else if (CP866_REVERSE[byte]) {
      out += CP866_REVERSE[byte]
    } else {
      out += '·'
    }
    i += 2
  }
  return out
}
