'use client'

import { useState, useRef } from 'react'
import { Camera } from 'lucide-react'
import { uploadDishImage } from '@/lib/queries'

// ─── Display component ───────────────────────────────────────────────────────

export function DishImage({
  imageUrl,
  name,
  size = 'md',
}: {
  imageUrl?: string
  emoji?: string  // deprecated — ignored
  name: string
  size?: 'sm' | 'md' | 'lg' | 'fill' | 'xs'
}) {
  const sizeMap = {
    xs: 'size-6 rounded-md',
    sm: 'size-8 rounded-lg',
    md: 'size-12 rounded-xl',
    lg: 'size-16 rounded-2xl',
    fill: 'w-full h-full',
  }
  const textSize = {
    xs: 'text-[8px]',
    sm: 'text-[9px]',
    md: 'text-[10px]',
    lg: 'text-xs',
    fill: 'text-sm',
  }
  const imgSize = {
    xs: 'size-6 rounded-md',
    sm: 'size-8 rounded-lg',
    md: 'size-12 rounded-xl',
    lg: 'size-16 rounded-2xl',
    fill: 'w-full h-full',
  }

  if (imageUrl) {
    return (
      <img
        src={imageUrl}
        alt={name}
        className={`${imgSize[size]} object-cover shrink-0`}
      />
    )
  }

  // Show dish name instead of emoji (like iiko)
  const shortName = name.length > 12 ? name.slice(0, 11) + '…' : name

  return (
    <div className={`${sizeMap[size]} bg-muted flex items-center justify-center shrink-0 p-0.5 overflow-hidden`}>
      <span className={`${textSize[size]} font-semibold text-muted-foreground text-center leading-tight`}>
        {shortName}
      </span>
    </div>
  )
}

// ─── Upload component ─────────────────────────────────────────────────────────

export function DishImageUpload({
  imageUrl,
  emoji,
  onImageUploaded,
}: {
  imageUrl?: string
  emoji?: string
  onImageUploaded: (url: string) => void
}) {
  const [uploading, setUploading] = useState(false)
  const [preview, setPreview] = useState<string | undefined>(imageUrl)
  const inputRef = useRef<HTMLInputElement>(null)

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    // Show preview immediately
    const reader = new FileReader()
    reader.onload = () => setPreview(reader.result as string)
    reader.readAsDataURL(file)

    setUploading(true)
    try {
      const url = await uploadDishImage(file)
      setPreview(url)
      onImageUploaded(url)
    } catch {
      // Keep preview even if upload fails
    } finally {
      setUploading(false)
    }
  }

  return (
    <div
      onClick={() => inputRef.current?.click()}
      className="relative size-20 rounded-2xl border-2 border-dashed border-border hover:border-primary/50 transition-colors cursor-pointer overflow-hidden bg-muted flex items-center justify-center group"
    >
      {preview ? (
        <img src={preview} alt="Dish" className="size-full object-cover" />
      ) : (
        <div className="flex flex-col items-center gap-1 text-muted-foreground group-hover:text-primary transition-colors">
          {emoji ? <span className="text-2xl">{emoji}</span> : <Camera className="size-5" />}
          <span className="text-[10px] font-medium">Фото</span>
        </div>
      )}

      {uploading && (
        <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
          <div className="size-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
        </div>
      )}

      {preview && !uploading && (
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 flex items-center justify-center transition-colors">
          <Camera className="size-5 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFile}
      />
    </div>
  )
}
