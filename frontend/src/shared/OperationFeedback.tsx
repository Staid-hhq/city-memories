import type { ReactNode } from 'react'

export type FeedbackTone = 'info' | 'progress' | 'success' | 'warning' | 'error'

export function OperationFeedback({ tone = 'info', title, children, actions }: {
  tone?: FeedbackTone; title: string; children?: ReactNode; actions?: ReactNode
}) {
  const marks = { info: 'i', progress: '…', success: '✓', warning: '!', error: '×' }
  return <div className={`operation-feedback is-${tone}`} role={tone === 'error' ? 'alert' : 'status'} aria-atomic="true">
    <span className="operation-feedback-mark" aria-hidden="true">{marks[tone]}</span>
    <div className="operation-feedback-content"><strong className="operation-feedback-title">{title}</strong>
      {children && <div className="operation-feedback-message">{children}</div>}
      {actions && <div className="operation-feedback-actions">{actions}</div>}
    </div>
  </div>
}
