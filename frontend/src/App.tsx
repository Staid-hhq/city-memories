import { useEffect, useState } from 'react'
import { Route, Routes } from 'react-router'

type HealthStatus = 'checking' | 'available' | 'unavailable'

function FoundationPage() {
  const [healthStatus, setHealthStatus] = useState<HealthStatus>('checking')

  useEffect(() => {
    const controller = new AbortController()

    fetch('/api/v1/health', {
      credentials: 'same-origin',
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`健康检查失败：${response.status}`)
        }
        setHealthStatus('available')
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return
        }
        setHealthStatus('unavailable')
      })

    return () => controller.abort()
  }, [])

  const statusText = {
    checking: '正在连接本地服务…',
    available: '前后端连接正常',
    unavailable: '后端尚未启动',
  }[healthStatus]

  return (
    <main className="foundation-page">
      <section className="foundation-card" aria-labelledby="page-title">
        <p className="eyebrow">CITY MEMORIES</p>
        <h1 id="page-title">城影记</h1>
        <p className="intro">把走过的城市，整理成可以慢慢翻看的年份影集。</p>
        <p className={`service-status service-status--${healthStatus}`} role="status">
          <span aria-hidden="true" />
          {statusText}
        </p>
        <p className="stage-note">正式工程基础已就绪，账号与私人影集将在下一阶段接入。</p>
      </section>
    </main>
  )
}

export function App() {
  return (
    <Routes>
      <Route path="*" element={<FoundationPage />} />
    </Routes>
  )
}
