package com.restos.waiter.util

/**
 * Кросслитеральный (транслитерационный) поиск: официант пишет латиницей, а
 * меню в кириллице (или наоборот) — «plov» должен находить «Плов», «шашлык» —
 * «shashlik». Обе стороны нормализуются к латинице, потом обычный contains.
 *
 * Не претендует на строгую ISO-9: цель — «на глаз похоже», чтобы поиск не
 * промахивался из-за раскладки/алфавита. Ы/И, Ц/TS и т.п. — неизбежные
 * неоднозначности транслита, допустимы.
 */
object Translit {

    // Кириллица (RU + UZ) → латиница. Заглавные не нужны — вход в lowercase().
    private val cyrToLat: Map<Char, String> = mapOf(
        'а' to "a", 'б' to "b", 'в' to "v", 'г' to "g", 'д' to "d", 'е' to "e",
        'ё' to "e", 'ж' to "zh", 'з' to "z", 'и' to "i", 'й' to "y", 'к' to "k",
        'л' to "l", 'м' to "m", 'н' to "n", 'о' to "o", 'п' to "p", 'р' to "r",
        'с' to "s", 'т' to "t", 'у' to "u", 'ф' to "f", 'х' to "h", 'ц' to "c",
        'ч' to "ch", 'ш' to "sh", 'щ' to "sh", 'ъ' to "", 'ы' to "y", 'ь' to "",
        'э' to "e", 'ю' to "yu", 'я' to "ya",
        // Узбекская кириллица.
        'қ' to "q", 'ғ' to "g", 'ҳ' to "h", 'ў' to "o",
    )

    /** В латиницу; кириллица транслитерируется, латиница/цифры — как есть,
     *  всё прочее (пробелы, пунктуация) отбрасывается для более цепкого contains. */
    fun normalize(input: String): String {
        val lower = input.lowercase()
        val sb = StringBuilder(lower.length)
        for (ch in lower) {
            val mapped = cyrToLat[ch]
            when {
                mapped != null -> sb.append(mapped)
                ch in 'a'..'z' || ch in '0'..'9' -> sb.append(ch)
                else -> Unit // пробелы/знаки пропускаем
            }
        }
        return sb.toString()
    }

    /** Совпадает ли [name] с поисковым запросом [query] в транслите. */
    fun matches(name: String, query: String): Boolean {
        val q = normalize(query)
        if (q.isEmpty()) return true
        return normalize(name).contains(q)
    }
}
