import { useTranslation } from 'react-i18next'
import type { ChatMessage } from '../../types'

export const WARM_TASK_BRIEF_KIND = 'warm_task_brief'
export const WARM_TASK_BRIEF_CLAIM_KIND = 'warm_task_brief_claim'

export interface WarmTaskBrief {
  originalRequest: string
  currentState: string[]
  nextSteps: string[]
}

export function warmTaskBriefOf(message: ChatMessage): WarmTaskBrief | null {
  const meta = message.meta
  if (meta?.kind !== WARM_TASK_BRIEF_KIND) return null
  const originalRequest = meta.original_request
  const currentState = meta.current_state
  const nextSteps = meta.next_steps
  if (
    typeof originalRequest !== 'string'
    || !Array.isArray(currentState)
    || !currentState.every(item => typeof item === 'string')
    || !Array.isArray(nextSteps)
    || nextSteps.length < 1
    || nextSteps.length > 3
    || !nextSteps.every(item => typeof item === 'string')
  ) return null
  return { originalRequest, currentState, nextSteps }
}

export function isWarmTaskBriefClaim(message: ChatMessage): boolean {
  return message.meta?.kind === WARM_TASK_BRIEF_CLAIM_KIND
}

export default function WarmTaskBriefCard({ brief }: { brief: WarmTaskBrief }) {
  const { t } = useTranslation()
  return (
    <article className="rounded-lg border border-border bg-bg-elevated px-4 py-3 text-[13px]" data-testid="warm-task-brief-card">
      <section>
        <h3 className="font-medium">{t('pages.membersPage.warm_task_brief_original')}</h3>
        <p className="mt-1 whitespace-pre-wrap break-words">{brief.originalRequest}</p>
      </section>
      <section className="mt-3">
        <h3 className="font-medium">{t('pages.membersPage.warm_task_brief_state')}</h3>
        <ul className="mt-1 list-disc space-y-1 pl-5">
          {brief.currentState.map((fact, index) => <li key={index}>{fact}</li>)}
        </ul>
      </section>
      <section className="mt-3">
        <h3 className="font-medium">{t('pages.membersPage.warm_task_brief_next')}</h3>
        <ol className="mt-1 list-decimal space-y-1 pl-5">
          {brief.nextSteps.map((step, index) => <li key={index}>{step}</li>)}
        </ol>
      </section>
    </article>
  )
}
