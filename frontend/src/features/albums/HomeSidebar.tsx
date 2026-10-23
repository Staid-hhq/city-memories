import { Link } from 'react-router'
import { errorMessage } from '../../shared/api'
import { OriginalImage } from '../photos/OriginalImage'
import type { Album, Atlas } from './types'

type RecentAlbums = {
  data?: { items: Album[] }; loading: boolean; error?: unknown; retry: () => void
}

export function HomeSidebar({ atlas, loading, retryAtlas, recent }: {
  atlas?: Atlas; loading: boolean; retryAtlas: () => void; recent: RecentAlbums
}) {
  const lit = atlas?.items.filter(item => item.lit && item.photo_count > 0).length
  return <aside className="home-sidebar" aria-label="我的旅行概览">
    <section className="home-sidebar-panel footprint-summary" aria-labelledby="footprint-summary-title">
      <p className="eyebrow">COLLECT YOUR MOMENTS</p><h2 id="footprint-summary-title">我的足迹</h2>
      <p className="sidebar-intro">把走过的地方，收进回忆里。</p>
      {atlas ? <dl className="footprint-stats"><div><dt>已点亮城市</dt><dd>{lit}</dd></div>
        <div><dt>年份影集</dt><dd>{atlas.album_count}</dd></div><div><dt>照片数</dt><dd>{atlas.photo_count}</dd></div></dl>
        : loading ? <p className="sidebar-status" role="status">正在读取足迹统计…</p>
          : <div className="sidebar-status"><p>足迹统计暂时不可用。</p><button className="quiet-button" onClick={retryAtlas}>重读足迹统计</button></div>}
      <Link className="sidebar-library-link" to="/albums">我的相册 <span aria-hidden="true">↗</span></Link>
    </section>
    <section className="home-sidebar-panel recent-albums" aria-labelledby="recent-albums-title">
      <div className="sidebar-section-heading"><h2 id="recent-albums-title">最近整理</h2><span>继续翻开回忆</span></div>
      {recent.loading ? <p className="sidebar-status" role="status">正在翻开最近的相册…</p>
        : !recent.data ? <div className="sidebar-status" role="alert"><p>{errorMessage(recent.error)}</p>
          <button className="quiet-button" onClick={recent.retry}>重试最近相册</button></div>
          : recent.data.items.length ? <div className="recent-album-list">{recent.data.items.map(album => <Link key={album.id} className="recent-album" to={`/albums/${album.id}`} state={{ albumOrigin: '/' }}>
            <div className="home-recent-cover" aria-hidden="true">{album.cover_photo_id ? <OriginalImage photoId={album.cover_photo_id} alt="" /> : <span>{album.city.name[0]}</span>}</div>
            <div className="home-recent-caption"><strong>{album.city.name}</strong><span>{album.year === null ? '未标年份' : `${album.year} 年`}</span><small>{album.photo_count} 张照片</small></div><span className="recent-album-arrow" aria-hidden="true">↗</span>
          </Link>)}</div> : <div className="sidebar-empty"><p>还没有相册，先留下一座城市。</p><Link to="/#choose-city-title">选择城市，创建影集 →</Link></div>}
      {!!recent.data?.items.length && <p className="sidebar-scope">按年份影集创建、照片或封面整理时间排列。</p>}
    </section>
    <Link className="home-start-entry" to="/#choose-city-title" aria-label="选择城市"><span><strong>下一段回忆</strong><small>选一座城市，开启新的影集</small></span><span aria-hidden="true">＋</span></Link>
  </aside>
}
