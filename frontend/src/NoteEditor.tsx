import { useEffect, useRef, useState } from 'react'
import { useBlocker } from 'react-router'
import { api, ApiError, errorMessage, isAbort } from './api'
import type { Note } from './photos'

export function NoteEditor({ initial, onSaved }: { initial: Note; onSaved: (note: Note) => void }) {
  const [base, setBase] = useState(initial)
  const [draft, setDraft] = useState(initial.note)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [conflict, setConflict] = useState(false)
  const [latest, setLatest] = useState<Note | null>(null)
  const request = useRef<AbortController | null>(null)
  const textarea = useRef<HTMLTextAreaElement | null>(null)
  const leavePrompt = useRef<HTMLDivElement | null>(null)
  const latestPanel = useRef<HTMLDivElement | null>(null)
  const dirty = draft !== base.note
  const length = [...draft].length
  const blocker = useBlocker(dirty || busy)
  useEffect(() => () => request.current?.abort(), [])
  useEffect(() => {
    if (latest) { latestPanel.current?.focus(); latestPanel.current?.scrollIntoView({ block: 'nearest' }) }
  }, [latest])
  useEffect(() => {
    if (!dirty && !busy) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty, busy])
  useEffect(() => {
    if (blocker.state === 'blocked') {
      if (!dirty && !busy) blocker.proceed()
      else leavePrompt.current?.focus()
    }
  }, [blocker, dirty, busy])
  async function save() {
    if (busy || conflict || length > 2000) return
    const controller = new AbortController()
    request.current = controller
    setBusy(true); setError(''); setNotice(''); setLatest(null)
    try {
      const result = await api<Note>(`/photos/${initial.id}/note`, {
        method: 'PATCH', signal: controller.signal,
        body: JSON.stringify({ note: draft, expected_photo_revision: base.revision }),
      })
      setBase(result); setDraft(result.note); onSaved(result)
      setNotice('文字已保存。原图和文件名没有改变。')
    } catch (reason) {
      if (!isAbort(reason)) {
        setConflict(reason instanceof ApiError && reason.code === 'PHOTO_CHANGED')
        setError(errorMessage(reason) + ' 未保存文字仍在本页；结果不明时先读取最新文字核对。')
      }
    } finally { if (!controller.signal.aborted) setBusy(false) }
  }
  async function readLatest() {
    const controller = new AbortController()
    request.current = controller
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await api<Note>(`/photos/${initial.id}?album_id=${initial.album_id}`, { signal: controller.signal })
      setLatest(result); setConflict(true)
    } catch (reason) { if (!isAbort(reason)) setError(errorMessage(reason) + ' 当前草稿仍保留。') }
    finally { if (!controller.signal.aborted) setBusy(false) }
  }
  function adopt(keepMine: boolean) {
    if (!latest) return
    setBase(latest)
    if (!keepMine) setDraft(latest.note)
    onSaved(latest)
    setLatest(null); setConflict(false); setError('')
    setNotice(keepMine ? '已核对最新版本；你的草稿尚未保存，请再次点击保存。' : '已采用服务端最新文字。')
    textarea.current?.focus()
  }
  return <section className="note-editor" aria-labelledby="note-title">
    <div className="section-heading"><h3 id="note-title">这一刻的文字</h3><span>{length} / 2000 字{dirty ? ' · 未保存' : ''}</span></div>
    <label className="sr-only" htmlFor="photo-note-input">照片文字</label>
    <textarea id="photo-note-input" ref={textarea} rows={4} value={draft} disabled={busy} aria-describedby="note-help"
      onChange={(event) => { setDraft(event.target.value); setNotice('') }} placeholder="记下那天的风景、心情，或者留白。" />
    <p id="note-help" className="scope-note">最多 2000 个 Unicode 字符，可留空；按纯文本保存，不执行 HTML，不自动保存。</p>
    {length > 2000 && <p className="form-error" role="alert">文字超过 2000 字，请缩短后保存；不会截断你的内容。</p>}
    <div className="upload-actions"><button className="primary-button" disabled={busy || !dirty || conflict || length > 2000} onClick={() => void save()}>{busy ? '正在处理…' : '保存文字'}</button>
      <button className="quiet-button" disabled={busy} onClick={() => void readLatest()}>读取最新文字核对</button></div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {notice && <p className="staged-notice" role="status">{notice}</p>}
    {latest && <div className="note-conflict" ref={latestPanel} tabIndex={-1}><h4>服务端最新文字</h4><p className="photo-note">{latest.note || '（空白）'}</p>
      <p className="scope-note">上方仍是你的草稿。请比较后选择；保留草稿不会立刻覆盖服务器。</p>
      <div className="upload-actions"><button className="quiet-button" onClick={() => adopt(false)}>采用最新文字</button><button className="quiet-button" onClick={() => adopt(true)}>保留我的草稿，按最新版本继续编辑</button></div>
    </div>}
    {blocker.state === 'blocked' && <div className="note-leave" ref={leavePrompt} tabIndex={-1} role="alert">
      <p>{busy ? '文字保存或核对尚未结束，请稍候。' : '还有未保存文字。要继续编辑，还是放弃草稿并离开？'}</p>
      <div className="upload-actions"><button className="quiet-button" onClick={() => { blocker.reset(); textarea.current?.focus() }}>继续编辑</button>
        <button className="quiet-button" disabled={busy} onClick={() => blocker.proceed()}>放弃草稿并离开</button></div>
    </div>}
  </section>
}
