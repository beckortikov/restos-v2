import { useState, useEffect } from 'react'
import { fetchNomenclature, type Nomenclature } from '@/lib/queries/transfers'

// useNetworkStatus — «этот ресторан состоит в сети?» (ADR-003). Определяется
// реактивно по ответу /nomenclature: ошибка "restaurant is not part of a
// network" → не в сети. Другого синхронного флага на фронте нет.
export function useNetworkStatus() {
  const [inNetwork, setInNetwork] = useState(false)
  const [nomenclature, setNomenclature] = useState<Nomenclature[]>([])

  useEffect(() => {
    let cancelled = false
    fetchNomenclature()
      .then((list) => { if (!cancelled) { setNomenclature(list); setInNetwork(true) } })
      .catch(() => { if (!cancelled) { setInNetwork(false); setNomenclature([]) } })
    return () => { cancelled = true }
  }, [])

  return { inNetwork, nomenclature }
}
