import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { act } from 'react'
import { defaultMessageRenderers } from '../app-sdk/messageRenderers'
import WarmTaskBriefCard, {
  isWarmTaskBriefClaim,
  warmTaskBriefOf,
} from '../pages/chat/WarmTaskBriefCard'
import { attachFocusRelay, emitSlotFocused, focusedSlotForCurrentSurface } from '../hooks/websocket/attention'
import { store } from '../store'
import { setActiveSlot } from '../store/chatSlice'
import {
  clearMountedMemberThreadSlot,
  setMountedMemberThreadSlot,
} from '../lib/mountedMemberThread'
import type { ChatMessage } from '../types'
import type { SocketConnection } from '../hooks/websocket/connection'
import chatReducer, { setWarmTaskBriefStatus } from '../store/chatSlice'
import { i18nT } from '../i18n/t'
import { isCrewmateChatRow } from '../components/chat/crewmateBubbles'

const row = (meta: Record<string, unknown>): ChatMessage => ({
  role: 'notice', content: '', cls: '', meta,
})

describe('warm task brief transcript row', () => {
  it('pins the preparing and unavailable copy', () => {
    expect(i18nT('pages.membersPage.warm_task_brief_preparing'))
      .toBe('Preparing your current-task summary. You can wait here.')
    expect(i18nT('pages.membersPage.warm_task_brief_unavailable'))
      .toBe("I couldn't prepare the current-task summary.")
  })

  it('keeps transient status per slot and clears it', () => {
    let state = chatReducer(undefined, setWarmTaskBriefStatus({ slot: 'member-ops', status: 'preparing' }))
    expect(state.warmTaskBriefStatus).toEqual({ 'member-ops': 'preparing' })
    state = chatReducer(state, setWarmTaskBriefStatus({ slot: 'member-ops', status: 'unavailable' }))
    expect(state.warmTaskBriefStatus).toEqual({ 'member-ops': 'unavailable' })
    state = chatReducer(state, setWarmTaskBriefStatus({ slot: 'member-ops', status: 'clear' }))
    expect(state.warmTaskBriefStatus).toEqual({})
  })

  it('renders exact source text as text with one to three next steps', () => {
    const message = row({
      kind: 'warm_task_brief',
      original_request: '<b>Fix it</b>',
      current_state: ['The failure is reproduced.'],
      next_steps: ['Apply the fix.', 'Run the test.'],
    })
    const brief = warmTaskBriefOf(message)
    expect(brief).not.toBeNull()
    render(<WarmTaskBriefCard brief={brief!} />)
    expect(screen.getByText('<b>Fix it</b>')).toBeInTheDocument()
    expect(screen.queryByText('Fix it')).toBeNull()
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
  })

  it('rejects malformed output and suppresses durable claim rows', () => {
    expect(warmTaskBriefOf(row({ kind: 'warm_task_brief', next_steps: [] }))).toBeNull()
    const claim = row({ kind: 'warm_task_brief_claim', fingerprint: 'abc' })
    expect(isWarmTaskBriefClaim(claim)).toBe(true)
    const renderer = defaultMessageRenderers.find(item => item.id === 'warm_task_brief_claim')!
    expect(renderer.match?.(claim)).toBe(true)
    expect(renderer.render(claim, {} as never)).toBeNull()
    expect(isCrewmateChatRow(claim)).toBe(false)
    expect(isCrewmateChatRow(row({
      kind: 'warm_task_brief', original_request: 'Fix it', current_state: ['Open'], next_steps: ['Continue'],
    }))).toBe(true)
  })
})

describe('warm task brief focus signal', () => {
  let hidden: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    clearMountedMemberThreadSlot()
    hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  })

  afterEach(() => {
    clearMountedMemberThreadSlot()
    hidden.mockRestore()
  })

  it('a non-chat route reports no retained chat slot', () => {
    const oldPath = window.location.pathname
    try {
      store.dispatch(setActiveSlot('slot-a'))
      window.history.pushState({}, '', '/settings')
      expect(focusedSlotForCurrentSurface()).toBeNull()
    } finally {
      window.history.pushState({}, '', oldPath || '/')
      store.dispatch(setActiveSlot(null))
    }
  })

  it('uses the visible mounted member thread and marks only visibility leave', () => {
    const sendIfOpen = vi.fn()
    const socket = {
      sendIfOpen,
      reconnectingRef: { current: false },
    } as unknown as SocketConnection
    const detach = attachFocusRelay({
      socket,
      flushSlotActivity: vi.fn(),
      onActiveSlotChange: vi.fn(),
    })

    act(() => setMountedMemberThreadSlot('member-ops'))
    expect(sendIfOpen).toHaveBeenLastCalledWith({ type: 'slot_focused', slot: 'member-ops' })

    act(() => emitSlotFocused(null))
    expect(sendIfOpen).toHaveBeenLastCalledWith({ type: 'slot_focused', slot: null })

    const beforeBlur = sendIfOpen.mock.calls.length
    act(() => window.dispatchEvent(new Event('blur')))
    expect(sendIfOpen).toHaveBeenCalledTimes(beforeBlur)

    hidden.mockReturnValue(true)
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(sendIfOpen).toHaveBeenLastCalledWith({ type: 'slot_focused', slot: null, hidden: true })

    hidden.mockReturnValue(false)
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(sendIfOpen).toHaveBeenLastCalledWith({ type: 'slot_focused', slot: 'member-ops' })
    detach()
  })
})
