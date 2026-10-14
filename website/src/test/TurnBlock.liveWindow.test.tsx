/**
 * One fold, both phases. A running turn keeps its newest 5 tool rows open and
 * folds the older ones; a settled turn folds by its mode. The same disclosure
 * value drives both, and a live row (running, awaiting approval, hosting an
 * app, opened by the user, focused) never folds. Every row is one plain keyed
 * <div>, folded with `hidden` on that same element.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createElement, useCallback, useState, type ReactNode } from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import type { DisplayItem, TurnItem } from '../pages/chat/types'
import TurnBlock from '../pages/chat/TurnBlock'
import SearchHighlightContext from '../hooks/SearchHighlightContext'
import { useReportRowActive } from '../pages/chat/rowActivity'

const tool = (n: number): TurnItem => ({ kind: 'single', msg: { role: 'tool', content: `🔧 Running: step${n}`, ts: `t${n}` }, idx: n })
const hidden = (n: number): TurnItem => ({ kind: 'single', msg: { role: 'tool', content: `✅ step${n}`, ts: `h${n}` }, idx: 200 + n })
const think = (content: string, ts: string, idx: number): TurnItem => ({ kind: 'single', msg: { role: 'thinking', content, ts }, idx })
const say = (content: string, ts: string, idx: number): TurnItem => ({ kind: 'single', msg: { role: 'assistant', content, ts }, idx })
const done = say('Done.', 'z', 50)
const turnOf = (items: TurnItem[], complete = false): Extract<DisplayItem, { kind: 'turn' }> => ({ kind: 'turn', items, complete })
const tools = (n: number) => Array.from({ length: n }, (_, i) => tool(i))
const tsOf = (it: TurnItem) => (it.kind === 'single' ? String(it.msg.ts) : '')

/** A row body that reports itself live, the way a running or pending pill does. */
function Live({ active, children }: { active: boolean; children: ReactNode }) {
  useReportRowActive(active)
  return <>{children}</>
}
const itemsBody = (it: TurnItem, i: number) => (
  <div data-testid={`item-${i}`}><button>{it.kind === 'single' ? it.msg.content : 'group'}</button></div>
)
/** renderItem whose rows with a `ts` in `live` report active. */
const renderLive = (live: ReadonlySet<string> = new Set()) =>
  (it: TurnItem, i: number) => <Live active={live.has(tsOf(it))}>{itemsBody(it, i)}</Live>
const renderItem = renderLive()

const row = (i: number) => screen.getByTestId(`item-${i}`).parentElement!
const isFolded = (i: number) => row(i).hasAttribute('hidden') && row(i).getAttribute('data-collapsed') === 'true'
const toggle = () => screen.getAllByRole('button').find(b => b.hasAttribute('aria-expanded'))!

describe('running window', () => {
  it('7 tool rows: 5 open, 2 behind one fold row', () => {
    render(<TurnBlock turn={turnOf(tools(7))} renderItem={renderItem} />)
    expect(toggle()).toHaveAccessibleName('2 earlier steps')
    expect(toggle()).toHaveAttribute('aria-expanded', 'false')
    expect([0, 1].every(isFolded)).toBe(true)
    expect([2, 3, 4, 5, 6].some(isFolded)).toBe(false)
  })

  it('5 tool rows or fewer: no fold row', () => {
    render(<TurnBlock turn={turnOf(tools(5))} renderItem={renderItem} />)
    expect(screen.queryAllByRole('button').some(b => b.hasAttribute('aria-expanded'))).toBe(false)
  })

  it('a hidden completion row is neither folded nor counted, and the toggle sits on a real row', () => {
    const items = [tool(0), hidden(0), ...tools(7).slice(1)]
    const { container } = render(<TurnBlock turn={turnOf(items)} renderItem={renderItem} />)
    expect(toggle()).toHaveAccessibleName('2 earlier steps')
    expect(isFolded(0)).toBe(true)
    expect(isFolded(1)).toBe(false)
    expect(isFolded(2)).toBe(true)
    // The toggle is right above row 0, the first row it folds.
    expect(container.firstElementChild?.querySelector('button[aria-expanded]')).toBe(toggle())
  })

  it('the reasoning row and answer text never fold', () => {
    const items = [think('plan', 'th', 99), say('Here is what I found so far.', 'a', 100), ...tools(7), think('more', 'th2', 101)]
    render(<TurnBlock turn={turnOf(items)} renderItem={renderItem} />)
    expect(isFolded(0)).toBe(false)
    expect(isFolded(1)).toBe(false)
    expect([2, 3].every(isFolded)).toBe(true)
  })

  it('a plain row is a bare <div> with no motion style', () => {
    render(<TurnBlock turn={turnOf(tools(7))} renderItem={renderItem} />)
    for (const i of [0, 6]) {
      expect(row(i).tagName).toBe('DIV')
      expect(row(i).getAttribute('style')).toBeNull()
    }
  })

  it('the chevron drops its transition under reduced motion', () => {
    render(<TurnBlock turn={turnOf(tools(7))} renderItem={renderItem} />)
    expect(toggle().querySelector('svg')?.getAttribute('class')).toContain('motion-reduce:transition-none')
  })
})

describe('live rows never fold', () => {
  it('a running or pending row older than the window stays open and is not counted', () => {
    render(<TurnBlock turn={turnOf(tools(7))} renderItem={renderLive(new Set(['t0']))} />)
    expect(isFolded(0)).toBe(false)
    expect(isFolded(1)).toBe(true)
    expect(toggle()).toHaveAccessibleName('1 earlier step')
  })

  it('a live row among the newest five does not shift an older row into view', () => {
    render(<TurnBlock turn={turnOf(tools(7))} renderItem={renderLive(new Set(['t6']))} />)
    expect([0, 1].every(isFolded)).toBe(true)
    expect(isFolded(2)).toBe(false)
  })

  it('a row that MOUNTS live is open in the first render, as a pending pill after a reload is', () => {
    const { container } = render(<TurnBlock turn={turnOf(tools(9))} renderItem={renderLive(new Set(['t0']))} />)
    expect(isFolded(0)).toBe(false)
    expect(container.querySelectorAll('[hidden]')).toHaveLength(3)
  })

  it('a row goes live after folding and comes back; it folds again once idle', () => {
    const { rerender } = render(<TurnBlock turn={turnOf(tools(7))} renderItem={renderLive()} />)
    expect(isFolded(0)).toBe(true)
    rerender(<TurnBlock turn={turnOf(tools(7))} renderItem={renderLive(new Set(['t0']))} />)
    expect(isFolded(0)).toBe(false)
    rerender(<TurnBlock turn={turnOf(tools(7))} renderItem={renderLive()} />)
    expect(isFolded(0)).toBe(true)
  })

  it('a live row stays open in a settled turn and even under an explicit fold', () => {
    render(<TurnBlock turn={turnOf([...tools(3), done], true)} renderItem={renderLive(new Set(['t1']))} />)
    expect(toggle()).toHaveAccessibleName('2 tool calls')
    expect(isFolded(0)).toBe(true)
    expect(isFolded(1)).toBe(false)
    fireEvent.click(toggle())
    fireEvent.click(toggle())
    expect(isFolded(1)).toBe(false)
  })

  it('a focused row does not fold until focus leaves it', () => {
    const { rerender } = render(<TurnBlock turn={turnOf(tools(5))} renderItem={renderItem} />)
    const btn = screen.getByTestId('item-0').querySelector('button')!
    act(() => btn.focus())
    rerender(<TurnBlock turn={turnOf(tools(7))} renderItem={renderItem} />)
    expect(isFolded(0)).toBe(false)
    expect(document.activeElement).toBe(btn)
    expect(isFolded(1)).toBe(true)
    act(() => screen.getByTestId('item-6').querySelector('button')!.focus())
    expect(isFolded(0)).toBe(true)
  })
})

/** A host that owns the turn's disclosure, as ChatPage does, and can unmount the row. */
function Host({ turn, mounted, collapseAll = false }: { turn: Extract<DisplayItem, { kind: 'turn' }>; mounted: boolean; collapseAll?: boolean }) {
  const [disclosure, setDisclosure] = useState<Record<string, boolean>>({})
  const setFor = useCallback((key: string, v: boolean) => setDisclosure(p => ({ ...p, [key]: v })), [])
  return mounted
    ? <TurnBlock turn={turn} renderItem={renderItem} collapseAll={collapseAll} disclosure={disclosure.k} disclosureKey="k" onDisclosureChange={setFor} />
    : null
}

describe('one disclosure across running, completion, resume and remount', () => {
  it('opened while running, completed while unmounted, remounted: still open', () => {
    const { rerender } = render(<Host turn={turnOf(tools(7))} mounted />)
    fireEvent.click(toggle())
    rerender(<Host turn={turnOf(tools(7))} mounted={false} />)
    rerender(<Host turn={turnOf([...tools(7), done], true)} mounted={false} />)
    rerender(<Host turn={turnOf([...tools(7), done], true)} mounted />)
    expect(toggle()).toHaveAccessibleName('Hide tool calls')
    expect(tools(7).some((_, i) => isFolded(i))).toBe(false)
  })

  it('a settled turn the user opened stays open when it resumes', () => {
    const { rerender } = render(<Host turn={turnOf([...tools(7), done], true)} mounted />)
    fireEvent.click(toggle())
    rerender(<Host turn={turnOf([...tools(7), done, tool(8)], false)} mounted />)
    expect(toggle()).toHaveAccessibleName('Hide earlier steps')
    expect(tools(7).some((_, i) => isFolded(i))).toBe(false)
  })

  it('opened then closed while running: the turn settles closed', () => {
    const { rerender } = render(<Host turn={turnOf(tools(7))} mounted />)
    fireEvent.click(toggle())
    fireEvent.click(toggle())
    rerender(<Host turn={turnOf([...tools(7), done], true)} mounted />)
    expect(toggle()).toHaveAttribute('aria-expanded', 'false')
    expect(toggle()).toHaveAccessibleName('7 tool calls')
  })

  it('without a host, an opened fold stays open through a running-flag flap and completion', () => {
    const { rerender } = render(<TurnBlock turn={turnOf(tools(7))} renderItem={renderItem} />)
    rerender(<TurnBlock turn={turnOf(tools(7), true)} renderItem={renderItem} />)
    rerender(<TurnBlock turn={turnOf(tools(8))} renderItem={renderItem} />)
    fireEvent.click(toggle())
    rerender(<TurnBlock turn={turnOf([...tools(8), done], true)} renderItem={renderItem} />)
    expect(toggle()).toHaveAttribute('aria-expanded', 'true')
    expect(toggle()).toHaveAccessibleName('Hide tool calls')
  })

  it('a search match in a folded row opens the fold', () => {
    const search = { term: 'later', caseSensitive: false, currentMessageIdx: 0, currentOccurrenceIdx: 0 }
    const items = [say('A later note that names the plan for the build.', 's0', 0), tool(1), say('The build passed and the change is ready for review.', 's2', 2)]
    render(
      <SearchHighlightContext.Provider value={search}>
        <TurnBlock turn={turnOf(items, true)} renderItem={renderItem} collapseAll />
      </SearchHighlightContext.Provider>,
    )
    expect(toggle()).toHaveAttribute('aria-expanded', 'true')
    expect(isFolded(0)).toBe(false)
  })
})

describe('completion never opens a folded row', () => {
  /** Every row that lost `hidden` during the window the observer saw. */
  const watchUnhide = (root: HTMLElement) => {
    const seen: Element[] = []
    const mo = new MutationObserver(() => {})
    mo.observe(root, { subtree: true, attributes: true, attributeFilter: ['hidden'], attributeOldValue: true })
    return () => {
      for (const r of mo.takeRecords()) if (r.oldValue !== null) seen.push(r.target as Element)
      mo.disconnect()
      return seen
    }
  }

  it('default mode, 40 tool rows: no folded row is shown at the completion flip', () => {
    const { container, rerender } = render(<TurnBlock turn={turnOf(tools(40))} renderItem={renderItem} />)
    const stop = watchUnhide(container)
    rerender(<TurnBlock turn={turnOf([...tools(40), done], true)} renderItem={renderItem} />)
    expect(stop()).toEqual([])
    expect(toggle()).toHaveAccessibleName('40 tool calls')
    expect(tools(40).every((_, i) => isFolded(i))).toBe(true)
  })

  it('collapseAll with no answer: the window rows stay folded', () => {
    const { container, rerender } = render(<TurnBlock turn={turnOf(tools(7))} renderItem={renderItem} collapseAll />)
    const stop = watchUnhide(container)
    rerender(<TurnBlock turn={turnOf(tools(7), true)} renderItem={renderItem} collapseAll />)
    expect(stop()).toEqual([])
    expect([0, 1].every(isFolded)).toBe(true)
  })

  it('collapseAll ending on a short sign-off: tool rows after the answer stay folded', () => {
    const items = [think('plan', 'th', 99), say('Here is the full report on the build, with every step listed.', 'a', 100), ...tools(7), say('ok', 'b', 101)]
    const { container, rerender } = render(<TurnBlock turn={turnOf(items)} renderItem={renderItem} collapseAll />)
    expect([2, 3].every(isFolded)).toBe(true)
    const stop = watchUnhide(container)
    rerender(<TurnBlock turn={turnOf(items, true)} renderItem={renderItem} collapseAll />)
    expect(stop()).toEqual([])
    expect([0, 2, 3].every(isFolded)).toBe(true)
    expect(isFolded(1)).toBe(false)
  })
})

describe('row identity: an app iframe is never detached', () => {
  let connects = 0
  let disconnects = 0
  if (!customElements.get('x-app-probe')) {
    customElements.define('x-app-probe', class extends HTMLElement {
      connectedCallback() { connects++ }
      disconnectedCallback() { disconnects++ }
    })
  }
  // beforeEach, not afterEach: the previous test's unmount runs after its own hooks.
  beforeEach(() => { connects = 0; disconnects = 0 })
  const app: TurnItem = { kind: 'single', msg: { role: 'tool', content: '🔧 Running: app', ts: 'app', meta: { tool_call_id: 'tc_app' } }, idx: 300 }
  const appIds = new Set(['tc_app'])
  const withApp = (live: ReadonlySet<string>) => (it: TurnItem, i: number) =>
    it === app ? <div data-testid={`item-${i}`}>{createElement('x-app-probe')}</div> : renderLive(live)(it, i)

  it('running to complete with the app row above the live fold', () => {
    const items = [app, ...tools(7)]
    const { rerender } = render(<TurnBlock turn={turnOf(items)} renderItem={withApp(new Set())} appToolCallIds={appIds} />)
    rerender(<TurnBlock turn={turnOf([...items, done], true)} renderItem={withApp(new Set())} appToolCallIds={appIds} />)
    expect(connects).toBe(1)
    expect(disconnects).toBe(0)
  })

  it('the toggle moving above the app row mid-run does not move the app row', () => {
    const items = [tool(0), app, ...tools(7).slice(1)]
    const { rerender } = render(<TurnBlock turn={turnOf(items)} renderItem={withApp(new Set(['t0']))} appToolCallIds={appIds} />)
    expect(isFolded(0)).toBe(false)
    rerender(<TurnBlock turn={turnOf(items)} renderItem={withApp(new Set())} appToolCallIds={appIds} />)
    expect(isFolded(0)).toBe(true)
    expect(disconnects).toBe(0)
  })

  it('a host with no app set: the app row reports itself live and never folds', () => {
    const live = (it: TurnItem, i: number) =>
      it === app ? <Live active><div data-testid={`item-${i}`}>{createElement('x-app-probe')}</div></Live> : renderItem(it, i)
    const items = [app, ...tools(7)]
    const { rerender } = render(<TurnBlock turn={turnOf(items)} renderItem={live} />)
    expect(isFolded(0)).toBe(false)
    rerender(<TurnBlock turn={turnOf([...items, done], true)} renderItem={live} />)
    expect(isFolded(0)).toBe(false)
    expect(disconnects).toBe(0)
  })
})
