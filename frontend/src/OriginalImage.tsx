import { useEffect, useRef, useState } from 'react'
import { errorMessage, isAbort, originalBytes } from './api'

function ImageBytes({ photoId, alt, retryable }: { photoId: string; alt: string; retryable: boolean }) {
  const [url, setUrl] = useState('')
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    let objectUrl = ''
    void originalBytes(photoId, controller.signal).then((blob) => {
      if (controller.signal.aborted) return
      objectUrl = URL.createObjectURL(blob)
      setUrl(objectUrl)
    }).catch((reason) => { if (!isAbort(reason)) setError(errorMessage(reason)) })
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [photoId, attempt])
  return <>
    {!error && !ready && <span className="image-placeholder" role="status">正在读取原图…</span>}
    {error ? <span className="image-placeholder"><span role={retryable ? 'alert' : undefined}>{error}</span>
      {retryable && <button className="quiet-button" onClick={() => { setUrl(''); setError(''); setReady(false); setAttempt((value) => value + 1) }}>重试读取原图</button>}
    </span> : url && <img src={url} alt={alt} decoding="async" onLoad={() => setReady(true)} onError={() => setError('原图未能显示，请重试。')} />}
  </>
}

export function OriginalImage({ photoId, alt, suspended = false, immediate = false, retryable = false }: {
  photoId: string; alt: string; suspended?: boolean; immediate?: boolean; retryable?: boolean
}) {
  const frame = useRef<HTMLSpanElement | null>(null)
  const [near, setNear] = useState(immediate)
  useEffect(() => {
    if (immediate || !frame.current) return
    const observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), { rootMargin: '160px 0px' })
    observer.observe(frame.current)
    return () => observer.disconnect()
  }, [immediate])
  return <span className="original-frame" ref={frame}>
    {!suspended && (immediate || near) ? <ImageBytes key={photoId} photoId={photoId} alt={alt} retryable={retryable} /> :
      <span className="image-placeholder" aria-hidden="true">原图 · 按需读取</span>}
  </span>
}
