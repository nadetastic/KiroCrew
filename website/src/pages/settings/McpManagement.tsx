import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { AlertTriangle, Check, ChevronRight, ExternalLink, Gauge, ListChecks, RefreshCw, Server as ServerIcon, Share2 } from 'lucide-react'
import {
  api,
  ApiError,
  type McpManagedServer,
  type McpMeasureProgress,
  type McpShareRecommendation,
  type McpShareReason,
} from '../../api/client'
import { Tabs, TabsContent, TabsCount, TabsList, TabsTrigger, type TabItem } from '../../components/ui/tabs'
import { TABS_RAIL_ROW_CLASS } from '../../components/ui/tabsPill'
import { Btn } from '../../components/ui'
import ErrorNotice from '../../components/ErrorNotice'
import { splitOnPlaceholder } from '../../lib/splitOnPlaceholder'
import { fmtBytes } from '../../i18n/format'
import { i18nT } from '../../i18n/t'

/**
 * MCP Management: one button per server, and what it buys.
 *
 * Every action is a real, labelled button. "Share this server" shares it: one
 * request records the exact launch it runs and marks it shared, and turns the
 * page-wide sharing switch on if it was off. A shared copy runs outside the
 * chat sandbox, so the row shows the launch it approves above the button, and
 * the approval covers that launch only: when the command, args or declared env
 * later change, the row reads "Paused · command changed", shows the new
 * command, and waits for "Use new command", which pins the launch it
 * showed. "Stop sharing" turns it off. "Share all" lists every launch first and
 * shares only on the button under that list.
 *
 * The servers that can never be shared (they give each chat its own
 * credentials, or its own desktop) arrive with `share_blocked` set: they offer
 * no share button and say why in one line.
 *
 * The hint under each row is a measured saving or nothing. `saves_bytes` is
 * read from this host's process table by the gateway; when it is absent there
 * is no hint. Never estimate one here.
 *
 * The second sub-view, "Sharing assessment", is read-only evidence for anyone
 * who wants to know why a server is or is not a good fit. It changes nothing.
 */

const DOCS_URL =
  'https://github.com/kirodotdev/KiroCrew/blob/main/docs/architecture/design-notes/mcp-stub-decoupling.md'

type GatewayStatus = {
  enabled: boolean
  stub: string[]
  stub_count: number
  running: boolean
  ping_ok: boolean
  supported: boolean
  // Stubbed servers whose launch the gateway has not recorded yet, keyed by
  // name. Optional: an older gateway does not send it.
  launch_refused?: Record<string, LaunchRefusal>
}

/** A shared server whose current launch is not recorded yet; it waits for a confirm. */
type LaunchRefusal = {
  reason: 'added_outside_dashboard' | 'changed_needs_reapproval'
  /** The launch approved before it changed, as the approval store displays it. */
  approved_commands?: string[][]
  approved_envs?: string[][]
}

/** What a server runs, read only when its Details are opened. */
type LaunchPreview = {
  name: string
  commands: string[][]
  envs: string[][]
  complete: boolean
  expected_launch?: string
}

/** Catalog key per refusal class the gateway sends in `share_blocked`. */
const SHARE_BLOCKED_KEY: Record<string, string> = {
  credential_vending: 'pages.mcpManagement.share_blocked_credentials',
  needs_tenant_nonce: 'pages.mcpManagement.share_blocked_own_copy',
  computer_use: 'pages.mcpManagement.share_blocked_computer',
}

function errorCode(error: unknown): unknown {
  if (!(error instanceof ApiError)) return undefined
  try {
    return JSON.parse(error.body)?.code
  } catch {
    return undefined
  }
}

function stubErrorKey(error: unknown): string {
  const code = errorCode(error)
  if (code === 'launch_unresolved') return 'pages.mcpManagement.stub_error_launch_unresolved'
  if (code === 'launch_over_cap') return 'pages.mcpManagement.stub_error_launch_over_cap'
  if (code === 'approval_write_failed') return 'pages.mcpManagement.stub_error_approval_write_failed'
  if (code === 'share_refused') return 'pages.mcpManagement.stub_error_share_refused'
  return 'pages.mcpManagement.stub_failed'
}

/** The two sub-views: the switches, and the evidence behind them. */
type McpView = 'servers' | 'assessment'

/**
 * Catalog KEYS, not prose: the strict i18n lint reads inside ALL-CAPS module
 * constants. An unrecognised tier falls back to "not measured".
 */
const STRENGTH_LABEL_KEY: Record<string, string> = {
  refuted: 'pages.mcpManagement.assessment.strength_refuted',
  disqualified: 'pages.mcpManagement.assessment.strength_disqualified',
  declared: 'pages.mcpManagement.assessment.strength_declared',
  measured: 'pages.mcpManagement.assessment.strength_measured',
  no_objection: 'pages.mcpManagement.assessment.strength_no_objection',
  unknown: 'pages.mcpManagement.assessment.strength_unknown',
}

/** One key per reason code the verdict engine emits. */
const REASON_LABEL_KEY: Record<string, string> = {
  observed_hazard: 'pages.mcpManagement.assessment.reason_observed_hazard',
  not_stdio: 'pages.mcpManagement.assessment.reason_not_stdio',
  session_bound_by_construction:
    'pages.mcpManagement.assessment.reason_session_bound_by_construction',
  rotating_secret_env: 'pages.mcpManagement.assessment.reason_rotating_secret_env',
  not_probed: 'pages.mcpManagement.assessment.reason_not_probed',
  degrades_when_shared: 'pages.mcpManagement.assessment.reason_degrades_when_shared',
  handshake_not_reproducible:
    'pages.mcpManagement.assessment.reason_handshake_not_reproducible',
  declares_caller_identity: 'pages.mcpManagement.assessment.reason_declares_caller_identity',
  all_tools_read_only: 'pages.mcpManagement.assessment.reason_all_tools_read_only',
  preflight_passed: 'pages.mcpManagement.assessment.reason_preflight_passed',
  preflight_not_run: 'pages.mcpManagement.assessment.reason_preflight_not_run',
  no_objection_found: 'pages.mcpManagement.assessment.reason_no_objection_found',
  no_tool_annotations: 'pages.mcpManagement.assessment.reason_no_tool_annotations',
  no_tools_listed: 'pages.mcpManagement.assessment.reason_no_tools_listed',
}

/**
 * The states a row can be in, as a closed set -- deliberately not the i18n keys,
 * so "is this row shared" is a type check rather than a string compare against a
 * key that lives in 13 catalogs.
 */
type McpRowState = 'no_stub' | 'needs_reapproval' | 'direct_env' | 'shared' | 'stub' | 'direct'

const STATE_LABEL_KEY: Record<McpRowState, string> = {
  no_stub: 'pages.mcpManagement.state_no_stub',
  needs_reapproval: 'pages.mcpManagement.state_needs_reapproval',
  direct_env: 'pages.mcpManagement.state_direct_env',
  shared: 'pages.mcpManagement.state_shared',
  stub: 'pages.mcpManagement.state_stub',
  direct: 'pages.mcpManagement.state_direct',
}

/**
 * What the server is running as, as ONE function used by both sub-views. The
 * chip, its colour and the assessment's warning all read this answer.
 */
function rowState(
  s: McpManagedServer,
  sharingOn: boolean,
  refused?: Record<string, LaunchRefusal>,
): McpRowState {
  if (!s.can_stub) return 'no_stub'
  if (s.stub && refused?.[s.name]) return 'needs_reapproval'
  if (s.stub && s.pooling_blocked_by_env === true) return 'direct_env'
  if (s.stub && sharingOn) return 'shared'
  if (s.stub) return 'stub'
  return 'direct'
}

function stateLabelKey(state: McpRowState): string {
  return STATE_LABEL_KEY[state]
}

/** Evidence tiers that argue AGAINST sharing, as opposed to merely not endorsing it. */
const CONTRARY_STRENGTHS = new Set(['refuted', 'disqualified'])

/** True when the server is shared right now and the evidence argues against it. */
function sharedWithoutSupport(
  s: McpManagedServer,
  sharingOn: boolean,
  refused?: Record<string, LaunchRefusal>,
): boolean {
  if (rowState(s, sharingOn, refused) !== 'shared') return false
  const rec = s.recommendation
  if (!rec) return false
  return CONTRARY_STRENGTHS.has(rec.strength)
}

/** How long the batch action waits for an uncapped measurement pass, in ms. */
const MEASURE_WAIT_MS = 4 * 60 * 1000
const MEASURE_POLL_MS = 1500

/**
 * Poll the measurement pass until it stops. True when it finished in time. Each
 * reading lands in the SAME cache entry `MeasureControl` reads, so the page has
 * one source of displayed progress.
 */
async function waitForMeasurePass(qc: QueryClient): Promise<boolean> {
  const deadline = Date.now() + MEASURE_WAIT_MS
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, MEASURE_POLL_MS))
    try {
      const p = await api.mcpMeasureProgress()
      qc.setQueryData(['mcp-measure-progress'], p)
      if (!p.running) return true
    } catch {
      // A failed read is not a finished pass; the deadline ends the loop.
    }
  }
  return false
}

function Switch({
  on,
  disabled,
  onClick,
  label,
  describedBy,
}: {
  on: boolean
  disabled?: boolean
  onClick: () => void
  label: string
  describedBy?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={onClick}
      className={[
        'relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full transition-colors',
        on ? 'bg-accent' : 'bg-[var(--border-strong,var(--border))]',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
      ].join(' ')}
    >
      <span
        className={[
          // The knob rides ON the accent fill, so it needs the same light face in
          // every theme; there is no token for that pairing.
          'absolute h-[18px] w-[18px] rounded-full bg-white shadow transition-all',
          on ? 'left-[18px]' : 'left-[2px]',
        ].join(' ')}
      />
    </button>
  )
}

/** Every character the C category covers: escaped, never rendered, in a launch. */
const HIDDEN_LAUNCH_CHAR = /\p{C}/u

/** A launch value as text a reader can see all of: invisible characters escaped. */
function visibleLaunchText(value: string): string {
  return Array.from(value, character => {
    if (!HIDDEN_LAUNCH_CHAR.test(character)) return character
    const code = character.codePointAt(0) ?? 0
    const zero = String.fromCharCode(48)
    if (code < 0x20) return JSON.stringify(character).slice(1, -1)
    if (code <= 0xff) {
      const hexPrefix = String.fromCharCode(92, 120)
      return `${hexPrefix}${code.toString(16).padStart(2, zero)}`
    }
    const unicodePrefix = String.fromCharCode(92, 117)
    if (code <= 0xffff) return `${unicodePrefix}${code.toString(16).padStart(4, zero)}`
    return `${unicodePrefix}{${code.toString(16)}}`
  }).join('')
}

/** Characters an argument may hold and still show bare; anything else is quoted. */
const BARE_ARG = /^[A-Za-z0-9_@%+=:,./-]+$/

/** One argument quoted the way the card's `shlex.join` does, so argument
 *  boundaries survive the join: `sh -c 'echo ok'` never reads as `sh -c echo ok`. */
function quoteArg(arg: string): string {
  if (arg !== '' && BARE_ARG.test(arg)) return arg
  // A single quote, and the shell's way to put one inside a quoted argument.
  const quote = String.fromCharCode(39)
  const doubleQuote = String.fromCharCode(34)
  const escaped = quote + doubleQuote + quote + doubleQuote + quote
  return quote + arg.split(quote).join(escaped) + quote
}

/** Whether a row offers a share action that approves a launch: a first share, or a changed command. */
function offersShare(server: McpManagedServer, waiting: boolean): boolean {
  return server.can_stub && (waiting || (!server.stub && !server.share_blocked))
}

/** The one read of what a server runs. Every surface uses this key, so what is shown is what is approved.
 *  The key carries whether the row waits on a changed command: a read cached before the
 *  change never stands in for the new one. */
function useLaunchPreview(name: string, enabled: boolean, waiting: boolean) {
  return useQuery<LaunchPreview>({
    queryKey: ['mcpGatewayLaunchPreview', name, waiting],
    queryFn: () => api.mcpGatewayLaunchPreview(name),
    enabled,
    retry: false,
  })
}

/** Every launch a server resolves to: its command, its env names, then their values. */
function LaunchList({ preview }: { preview?: LaunchPreview }) {
  const launches = (preview?.commands ?? [])
    .map((argv, i) => ({ argv, env: preview?.envs?.[i] ?? [] }))
    .filter(launch => launch.argv.length > 0)
  return (
    <>
      {launches.length > 1 && (
        <p>{i18nT('pages.mcpManagement.details_variants', { count: launches.length })}</p>
      )}
      {launches.map((launch, i) => (
        <div key={i} className="space-y-0.5">
          {/* pre-wrap: runs of spaces inside an argument must show as they run. */}
          <code className="block whitespace-pre-wrap break-words font-mono text-[11.5px] text-[var(--text)] [overflow-wrap:anywhere]">
            {launch.argv.map(arg => visibleLaunchText(quoteArg(arg))).join(' ')}
          </code>
          {launch.env.length > 0 && (
            <ul aria-label={i18nT('pages.mcpManagement.reapproval_env')} className="space-y-0.5">
              {launch.env.map((entry, entryIndex) => (
                <li
                  key={entryIndex}
                  className="whitespace-pre-wrap break-words font-mono text-[11px] text-[var(--muted)] [overflow-wrap:anywhere]"
                >
                  {visibleLaunchText(entry)}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </>
  )
}

/**
 * What a share would approve, shown in the row before its button can be
 * pressed. A shared copy runs as the person outside the chat sandbox, and the
 * command can be agent-written, so an approval covers only a launch shown here.
 */
function ShareLaunch({
  server,
  waiting,
  refusal,
  alsoStarts,
}: {
  server: McpManagedServer
  waiting: boolean
  refusal?: LaunchRefusal
  /** Marked servers that start sharing too, because this press turns sharing on. */
  alsoStarts: string[]
}) {
  const offered = offersShare(server, waiting)
  const preview = useLaunchPreview(server.name, offered, waiting)
  if (!offered || !preview.data?.complete) return null
  const approved = waiting && refusal?.approved_commands?.length
    ? { name: server.name, commands: refusal.approved_commands, envs: refusal.approved_envs ?? [], complete: true }
    : null
  return (
    <div className="mt-2 space-y-1.5 rounded-lg border border-[var(--border)] px-3 py-2 text-[12px] leading-relaxed text-[var(--muted)]">
      <p className="font-medium text-[var(--text)]">
        {i18nT(waiting ? 'pages.mcpManagement.share_runs_new' : 'pages.mcpManagement.share_runs')}
      </p>
      <p>{i18nT('pages.mcpManagement.share_access')}</p>
      {server.agents.length > 0 && (
        <p className="break-words [overflow-wrap:anywhere]">
          {i18nT('pages.mcpManagement.share_set_in', { agents: server.agents.join(', ') })}
        </p>
      )}
      <LaunchList preview={preview.data} />
      {approved && (
        <div className="space-y-1 border-t border-[var(--border)] pt-1.5">
          <p className="font-medium text-[var(--text)]">{i18nT('pages.mcpManagement.share_approved_before')}</p>
          <LaunchList preview={approved} />
        </div>
      )}
      {alsoStarts.length > 0 && (
        <p className="border-t border-[var(--border)] pt-1.5 text-[var(--text)]">
          {i18nT('pages.mcpManagement.share_also_starts', { names: alsoStarts.join(', ') })}
        </p>
      )}
    </div>
  )
}

/**
 * The debugging view of a server, collapsed by default and loaded on open:
 * which agents declare it, and, when the row does not already show it, every
 * launch it resolves to.
 */
function ServerDetails({ server, showLaunch }: { server: McpManagedServer; showLaunch: boolean }) {
  const [open, setOpen] = useState(false)
  const preview = useLaunchPreview(server.name, open && showLaunch && server.can_stub, false)
  return (
    <details
      className="group mt-1"
      open={open}
      onToggle={e => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[12px] text-[var(--muted)] hover:text-[var(--text)] [&::-webkit-details-marker]:hidden">
        <ChevronRight size={12} className="transition-transform group-open:rotate-90" aria-hidden="true" />
        {i18nT('pages.mcpManagement.details')}
      </summary>
      <div className="mt-1.5 space-y-1.5 pl-4 text-[12px] leading-relaxed text-[var(--muted)]">
        <p className="break-words [overflow-wrap:anywhere]">
          {i18nT('pages.mcpManagement.details_used_by', { agents: server.agents.join(', ') })}
        </p>
        {open && preview.isLoading && (
          <p role="status">{i18nT('pages.mcpManagement.details_loading')}</p>
        )}
        {preview.isError && (
          <ErrorNotice variant="inline" message={i18nT('pages.mcpManagement.details_failed')} askAgent />
        )}
        {showLaunch && <LaunchList preview={preview.data} />}
      </div>
    </details>
  )
}

/** Every share action is a real, labelled button, never a bare switch or link. */
const SHARE_BUTTON_CLASS =
  'shrink-0 px-3 py-1.5 font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]'

/**
 * The one action a row offers. A shared copy runs outside the chat sandbox, so
 * a command that changed after it was shared waits here until the person
 * confirms the new one, which the row shows above its buttons and pins.
 */
function ShareAction({
  server,
  waiting,
  busy,
  supported,
  describedBy,
  onShare,
}: {
  server: McpManagedServer
  waiting: boolean
  busy: boolean
  supported: boolean
  describedBy?: string
  onShare: (stub: boolean, expectedLaunch?: string) => void
}) {
  // Same key as the launch the row shows, so the launch approved is the one
  // on screen. Both share actions send the `expected_launch` they read and
  // stay disabled until there is one.
  const offered = offersShare(server, waiting)
  const preview = useLaunchPreview(server.name, offered, waiting)
  const expected = preview.data?.complete ? preview.data.expected_launch : undefined
  if (!server.can_stub) return null
  const stopButton = (
    <Btn
      type="button"
      className={SHARE_BUTTON_CLASS}
      disabled={busy}
      aria-label={i18nT('pages.mcpManagement.unshare_button_aria', { name: server.name })}
      aria-describedby={describedBy}
      onClick={() => onShare(false)}
    >
      {i18nT('pages.mcpManagement.unshare_button')}
    </Btn>
  )
  if (waiting) {
    // Stop sharing stays reachable: a changed launch the person cannot or will
    // not confirm must still be turnable off.
    return (
      <div className="flex w-full min-w-0 flex-wrap items-center gap-2 md:w-auto md:justify-end">
        {stopButton}
        <Btn
          type="button"
          primary
          className={SHARE_BUTTON_CLASS}
          disabled={busy || !supported || !expected}
          aria-label={i18nT('pages.mcpManagement.new_command_aria', { name: server.name })}
          aria-describedby={describedBy}
          onClick={() => onShare(true, expected)}
        >
          <Check size={14} aria-hidden="true" />
          {i18nT('pages.mcpManagement.new_command_button')}
        </Btn>
        {preview.isError && (
          <div className="basis-full">
            <ErrorNotice variant="inline" message={i18nT('pages.mcpManagement.share_unreadable')} askAgent />
          </div>
        )}
      </div>
    )
  }
  if (server.stub) return stopButton
  if (server.share_blocked) return null
  // A launch read that answered but gave nothing to pin cannot be shared at
  // all: say so in place of the button, like a refused server.
  if (preview.isSuccess && !expected) {
    return (
      <span className="text-[12px] text-[var(--muted)] md:text-right">
        {i18nT('pages.mcpManagement.share_unreadable')}
      </span>
    )
  }
  // Say why the button is off once the read is done and gave nothing to pin;
  // a failed read is an error and goes through ErrorNotice.
  return (
    <div className="flex w-full min-w-0 flex-col items-start gap-1 md:w-auto md:items-end">
      <Btn
        type="button"
        primary
        className={SHARE_BUTTON_CLASS}
        disabled={busy || !supported || !expected}
        aria-label={i18nT('pages.mcpManagement.stub_aria', { name: server.name })}
        aria-describedby={describedBy}
        onClick={() => onShare(true, expected)}
      >
        <Share2 size={14} aria-hidden="true" />
        {i18nT('pages.mcpManagement.share_button')}
      </Btn>
      {preview.isLoading && (
        <span role="status" className="text-[12px] text-[var(--muted)]">
          {i18nT('pages.mcpManagement.share_checking')}
        </span>
      )}
      {preview.isError && (
        <ErrorNotice variant="inline" message={i18nT('pages.mcpManagement.share_unreadable')} askAgent />
      )}
    </div>
  )
}

/** The one hint under a row's switch: why it is off-limits, or what it saves. */
function shareHint(s: McpManagedServer): string | null {
  if (s.share_blocked) {
    return i18nT(SHARE_BLOCKED_KEY[s.share_blocked] ?? 'pages.mcpManagement.stub_error_share_refused')
  }
  if (!s.can_stub || s.stub) return null
  if (typeof s.saves_bytes === 'number' && s.saves_bytes > 0) {
    return i18nT('pages.mcpManagement.share_saves', {
      size: fmtBytes(s.saves_bytes, { maximumFractionDigits: 0 }),
    })
  }
  // No measurement, no line: "Saves memory" alone says nothing a number would not.
  return null
}

/** One reason line: a translated sentence, and the server's own verbatim detail.
 *
 *  The detail sits on its own line as a chip rather than inline. Appending a raw
 *  token to the end of a sentence made the two read as one broken sentence
 *  ("...belongs to one client logging_level"), and it quietly required every
 *  reason string to be worded so that a token could follow it. As a chip the
 *  sentence stands alone and the token reads as the tag it is.
 */
function ReasonLine({ reason }: { reason: McpShareReason }) {
  const key = REASON_LABEL_KEY[reason.code]
  return (
    <li className="min-w-0 leading-relaxed">
      {/* An unknown code still has to say something, and its raw code is more
          use to whoever has to look it up than a blank cell. */}
      <span>{key ? i18nT(key) : reason.code}</span>
      {reason.detail && (
        <span className="mt-0.5 block w-fit max-w-full break-words rounded border border-[var(--border)] px-1 font-mono text-[11px] text-[var(--text)] [overflow-wrap:anywhere]">
          {reason.detail}
        </span>
      )}
    </li>
  )
}

function AssessmentRow({
  server,
  sharingOn,
  refused,
}: {
  server: McpManagedServer
  sharingOn: boolean
  refused?: Record<string, LaunchRefusal>
}) {
  const rec: McpShareRecommendation | undefined = server.recommendation
  const strengthKey = rec ? STRENGTH_LABEL_KEY[rec.strength] : undefined
  // `no_objection_found` says only what the Assessment pill already says, so it
  // yields whenever the row has a reason specific to this server. It is kept when
  // it is the only one, because an empty Evidence cell beside a filled verdict
  // reads as missing data rather than as nothing further to report.
  const reasons = (rec?.reasons ?? []).filter(
    (r, _i, all) => r.code !== 'no_objection_found' || all.length === 1,
  )
  const unsupported = sharedWithoutSupport(server, sharingOn, refused)
  return (
    <tr className="grid min-w-0 grid-cols-1 gap-3 border-t border-[var(--border)] px-3 py-3 md:table-row md:px-0 md:py-0">
      <td className="min-w-0 break-words p-0 align-top font-mono text-[13px] text-[var(--text)] [overflow-wrap:anywhere] md:table-cell md:px-4 md:py-3">
        {server.name}
      </td>
      <td className="min-w-0 p-0 align-top md:table-cell md:px-4 md:py-3">
        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)] md:hidden">
          {i18nT('pages.mcpManagement.assessment.col_assessment')}
        </span>
        <span
          className={[
            'inline-block rounded-full px-2 py-0.5 font-mono text-[11px]',
            rec?.recommendShare
              ? 'bg-[var(--accent-subtle,transparent)] text-[var(--accent)]'
              : 'border border-[var(--border)] text-[var(--muted)]',
          ].join(' ')}
        >
          {i18nT(strengthKey || 'pages.mcpManagement.assessment.strength_unknown')}
        </span>
      </td>
      <td className="min-w-0 p-0 align-top text-[12.5px] text-[var(--muted)] [overflow-wrap:anywhere] md:table-cell md:px-4 md:py-3">
        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)] md:hidden">
          {i18nT('pages.mcpManagement.assessment.col_evidence')}
        </span>
        {reasons.length > 0 ? (
          <ul className="min-w-0 list-none space-y-0.5">
            {reasons.map((r, i) => (
              <ReasonLine key={`${r.code}-${i}`} reason={r} />
            ))}
          </ul>
        ) : (
          <span aria-hidden="true">{'\u2014'}</span>
        )}
      </td>
      <td className="min-w-0 p-0 align-top text-left md:table-cell md:px-4 md:py-3 md:text-right">
        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)] md:hidden">
          {i18nT('pages.mcpManagement.assessment.col_running_as')}
        </span>
        <span
          className={[
            'inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 font-mono text-[11px]',
            unsupported
              ? 'border border-[var(--danger)] text-[var(--danger)]'
              : 'border border-[var(--border)] text-[var(--muted)]',
          ].join(' ')}
        >
          {/* Colour cannot be the only thing that separates a flagged row from a
              healthy one, so the flag carries a mark of its own. It is decorative
              to a screen reader because the row's Assessment cell already states
              the verdict in words. */}
          {unsupported && <AlertTriangle size={11} aria-hidden="true" />}
          {i18nT(stateLabelKey(rowState(server, sharingOn, refused)))}
        </span>
      </td>
    </tr>
  )
}

/**
 * Sharing assessment — read-only. Reads the SAME query the servers table does, so
 * the two views can never disagree about which servers exist, and opening this tab
 * costs no request and starts no server.
 */
/**
 * The one control on this view: measure the servers that have no verdict yet.
 *
 * It exists because the assessment is only as useful as the number of rows that
 * carry a measurement, and the pass that produces them was previously reachable
 * only as a side effect of an icon-only refresh that measures a couple of servers
 * per press. A fleet of thirty needs fifteen presses and a guess about what the
 * icon does, which is why this button says what it does and how much is left.
 *
 * Progress is polled rather than streamed: the pass is minutes long at worst, a
 * two-second read costs nothing next to two process spawns per server, and a
 * dropped poll self-corrects on the next one where a dropped stream event does
 * not.
 */
function MeasureControl({ unmeasuredCount }: { unmeasuredCount: number }) {
  const qc = useQueryClient()
  const [asked, setAsked] = useState(false)

  const progress = useQuery({
    queryKey: ['mcp-measure-progress'],
    queryFn: () => api.mcpMeasureProgress(),
    // Only poll while a pass is actually running. Polling a finished pass forever
    // would keep a timer alive on a settings page nobody is looking at.
    refetchInterval: (q) => (q.state.data?.running ? 2000 : false),
    // A pass started from another tab (or before this page mounted) still has to
    // show up here, so the first read happens on mount rather than on click --
    // which is the default, stated here because the interval above is not.
  })

  const start = useMutation({
    mutationFn: () => api.mcpMeasureStart(),
    onSuccess: (data) => {
      setAsked(true)
      qc.setQueryData(['mcp-measure-progress'], data)
    },
  })

  const running = progress.data?.running === true
  const done = progress.data?.done ?? 0
  const measured = progress.data?.measured ?? 0
  const total = progress.data?.total ?? 0

  // The verdicts the pass just wrote live in a DIFFERENT query, and nothing else
  // refetches it: without this the operator watches progress reach the end and
  // then reads a table still saying "not measured", beside a button still
  // offering the same count. That contradiction is the end of every single use of
  // this control, so the refresh belongs here and not in a manual reload.
  //
  // Keyed on the running edge rather than on the mutation, because a pass started
  // from another tab settles here too and its result is just as stale.
  const wasRunning = useRef(false)
  useEffect(() => {
    if (wasRunning.current && !running) {
      void qc.invalidateQueries({ queryKey: ['mcpGatewayServers'] })
    }
    wasRunning.current = running
  }, [running, qc])

  // A pass that stopped early. Deliberately NOT gated on this session: a died
  // pass is otherwise indistinguishable from one that had nothing to do, which is
  // the difference between measured and never measured.
  const failed = !!progress.data?.error && !running

  // A pass this session that has stopped and measured something. Not shown for a
  // pass that only ever ran in some earlier session: "finished" with no numbers
  // attached tells the reader nothing they can use. Excludes a failed pass, and
  // counts what was actually MEASURED rather than what was attempted -- a pass
  // that died at 1 of 5 must not close with "Measured 5 servers".
  //
  // `measured` and `done` are separate fields because a pass can attempt a server
  // and measure nothing: a missing credential or a host where the probe cannot
  // spawn leaves no verdict, so the row stays unmeasured and this button keeps
  // offering it. Gating on `done` closed with "Measured 30 servers" beside a table
  // still showing thirty unmeasured rows. Gating on `measured` withholds the line
  // entirely when nothing was measured, which is silent but never false -- the
  // button's own unchanged count is what tells the reader nothing landed.
  const settled = asked && !running && measured > 0 && !failed

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => start.mutate()}
          disabled={running || start.isPending || unmeasuredCount === 0}
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] px-3 py-1.5 text-[13px] text-[var(--text)] hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Gauge size={14} className="shrink-0" />
          {unmeasuredCount > 0
            ? i18nT('pages.mcpManagement.assessment.measure_unmeasured', {
                count: unmeasuredCount,
              })
            : i18nT('pages.mcpManagement.assessment.measure_none_left')}
        </button>

        {running && (
          <span role="status" className="text-[12.5px] text-[var(--muted)]">
            {i18nT('pages.mcpManagement.assessment.measure_running', { done, total })}
          </span>
        )}
        {settled && (
          <span role="status" className="text-[12.5px] text-[var(--muted)]">
            {i18nT('pages.mcpManagement.assessment.measure_finished', { count: measured })}
          </span>
        )}
      </div>
      {/* Failures sit UNDER the Measure row, not beside the button: each notice
          carries a hand-off link, and a link in that row is a third action
          (max-two-buttons-per-row). */}
      {/* A pass that stopped early is reported here rather than only in the log:
          the operator is watching this readout and would otherwise read a short
          pass as a completed one. One notice for both causes -- a died pass and a
          start that never got going read the same string, and two copies of it
          side by side said nothing the first did not. */}
      <ErrorNotice
        variant="inline"
        message={failed || start.isError ? i18nT('pages.mcpManagement.assessment.measure_failed') : null}
        askAgent
      />
      {/* A failed progress read is not a failed pass: the pass may be running
          fine behind an endpoint this tab cannot reach. Left silent, the readout
          simply froze, which reads as "nothing is happening". */}
      <ErrorNotice
        variant="inline"
        message={progress.isError ? i18nT('pages.mcpManagement.assessment.measure_progress_failed') : null}
        askAgent
      />
    </div>
  )
}

function AssessmentView({
  servers,
  sharingOn,
  refused,
  loading,
  isError,
  onOpenServers,
  unsupportedCount,
  unmeasuredCount,
}: {
  servers: McpManagedServer[]
  sharingOn: boolean
  refused?: Record<string, LaunchRefusal>
  loading: boolean
  isError: boolean
  onOpenServers: () => void
  unsupportedCount: number
  unmeasuredCount: number
}) {
  return (
    <div className="space-y-4">
      <p className="max-w-[76ch] text-[13px] leading-relaxed text-[var(--muted)]">
        {i18nT('pages.mcpManagement.assessment.lede')}
      </p>
      {/* Where the verdicts come from. Without this, a fleet whose rows mostly read
          "not measured" looks like a feature that does not work, rather than one
          waiting on a probe that runs elsewhere and a couple of servers at a time.
          The destination is a link because naming a place the reader has to find
          themselves is most of the friction this line exists to remove. */}
      <p className="max-w-[76ch] text-[12.5px] leading-relaxed text-[var(--muted)]">
        {splitOnPlaceholder(i18nT('pages.mcpManagement.assessment.how_measured'), 'link').map(
          (part, i) =>
            part === null ? (
              <Link
                key="link"
                to="/capabilities?tab=mcp"
                className="text-[var(--accent)] hover:underline"
              >
                {i18nT('pages.mcpManagement.assessment.connections_link')}
              </Link>
            ) : (
              <span key={i}>{part}</span>
            ),
        )}
      </p>

      <MeasureControl unmeasuredCount={unmeasuredCount} />

      {/* Only ever shown when there is something to show. A count of zero is the
          normal state and saying so every time trains people to ignore the line. */}
      {unsupportedCount > 0 && (
        <div
          role="status"
          className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 gap-y-2 rounded-lg border border-[var(--danger)] bg-[var(--danger-subtle,transparent)] px-3.5 py-2.5 text-[13px] text-[var(--text)] md:grid-cols-[auto_minmax(0,1fr)_auto]"
        >
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-[var(--danger)]" />
          <span className="min-w-0">
            {i18nT('pages.mcpManagement.assessment.shared_without_support', {
              count: unsupportedCount,
            })}
          </span>
          {/* The remedy is a switch on the other tab, so the warning carries the
              way there. Navigation, not a control: nothing about a server changes
              from this view. */}
          <button
            type="button"
            onClick={onOpenServers}
            className="col-start-2 justify-self-start rounded-md border border-[var(--border)] px-2 py-0.5 text-[12.5px] text-[var(--text)] hover:border-[var(--accent)] md:col-start-3 md:row-start-1"
          >
            {i18nT('pages.mcpManagement.assessment.open_servers')}
          </button>
        </div>
      )}

      <section className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)]">
        <table className="block w-full border-collapse md:table">
          <thead className="hidden md:table-header-group">
            <tr>
              <th className="w-[26%] px-4 pb-2.5 pt-3.5 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">
                {i18nT('pages.mcpManagement.col_server')}
              </th>
              <th className="w-[20%] px-4 pb-2.5 pt-3.5 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">
                {i18nT('pages.mcpManagement.assessment.col_assessment')}
              </th>
              <th className="w-[38%] px-4 pb-2.5 pt-3.5 text-left text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">
                {i18nT('pages.mcpManagement.assessment.col_evidence')}
              </th>
              <th className="w-[16%] px-4 pb-2.5 pt-3.5 text-right text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">
                {i18nT('pages.mcpManagement.assessment.col_running_as')}
              </th>
            </tr>
          </thead>
          <tbody className="block md:table-row-group">
            {servers.map(s => (
              <AssessmentRow key={s.name} server={s} sharingOn={sharingOn} refused={refused} />
            ))}
            {isError && (
              <tr className="block border-t border-[var(--border)] md:table-row">
                <td colSpan={4} className="block px-4 py-4 md:table-cell">
                  <ErrorNotice message={i18nT('pages.mcpManagement.servers_failed')} askAgent />
                </td>
              </tr>
            )}
            {servers.length === 0 && !loading && !isError && (
              <tr className="block border-t border-[var(--border)] md:table-row">
                <td colSpan={4} className="block px-4 py-6 text-center text-[13px] text-[var(--muted)] md:table-cell">
                  {i18nT('pages.mcpManagement.no_servers')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  )
}


export function McpManagement() {
  const qc = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // A change that waits for a restart is information, not a failure.
  const [restartNotice, setRestartNotice] = useState<string | null>(null)
  const [resolveNotice, setResolveNotice] = useState<string | null>(null)
  const [resolveError, setResolveError] = useState<string | null>(null)

  const statusQ = useQuery<GatewayStatus>({
    queryKey: ['mcpGatewayStatus'],
    queryFn: () => api.mcpGatewayStatus(),
  })
  const serversQ = useQuery<{ servers: McpManagedServer[] }>({
    queryKey: ['mcpGatewayServers'],
    queryFn: () => api.mcpGatewayServers(),
  })

  const status = statusQ.data
  const servers = useMemo(() => serversQ.data?.servers ?? [], [serversQ.data])
  const stubCount = useMemo(() => servers.filter(s => s.stub).length, [servers])
  // Marked servers the assessment argues against: they start the moment
  // page-wide sharing turns on, so the page names them before that press.
  const contraryMarked = useMemo(
    () =>
      servers
        .filter(s => s.stub && s.recommendation && CONTRARY_STRENGTHS.has(s.recommendation.strength))
        .map(s => s.name),
    [servers],
  )
  // The header counts the rows whose chip reads "Shared": a row waiting for its
  // new command, or one paused because sharing is off, is not counted.
  const switchedOnCount = useMemo(
    () =>
      servers.filter(s => rowState(s, !!status?.enabled, status?.launch_refused) === 'shared').length,
    [servers, status],
  )
  const supported = status?.supported ?? true

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['mcpGatewayStatus'] })
    void qc.invalidateQueries({ queryKey: ['mcpGatewayServers'] })
    // A launch can change with any of these writes; never show a stale one beside a button.
    void qc.invalidateQueries({ queryKey: ['mcpGatewayLaunchPreview'] })
  }

  const setSharing = useMutation({
    mutationFn: (enabled: boolean) => api.mcpGatewayEnable(enabled),
    // Enabling can persist and still leave sharing unreachable; `ping_ok` says so.
    onSuccess: (res, enabled) => {
      invalidate()
      if (enabled && !res.ping_ok) setError(i18nT('pages.mcpManagement.sharing_not_live'))
    },
    onError: () => {
      invalidate()
      setError(i18nT('pages.mcpManagement.sharing_failed'))
    },
  })

  // One press, one request. Sharing records the exact launch the server runs and
  // marks it shared; the endpoint refuses the classes that can never be shared.
  // Confirming a changed command pins the launch the opened Details showed, so a
  // launch that moved again in between is refused rather than approved. A row
  // shared while sharing is off turns sharing on too: the person asked for this
  // server to be shared, and a second switch elsewhere would make that two steps.
  const setStub = useMutation({
    mutationFn: ({ name, stub, expectedLaunch }: { name: string; stub: boolean; expectedLaunch?: string }) =>
      api.mcpGatewaySetStub(name, stub, expectedLaunch),
    onSuccess: (res, vars) => {
      invalidate()
      if (vars.stub && supported && !status?.enabled && !setSharing.isPending) {
        setSharing.mutate(true)
      }
      if (res && res.restart_required) {
        setRestartNotice(i18nT('pages.mcpManagement.stub_restart_required'))
      } else if (res && res.applied === false) {
        setError(i18nT('pages.mcpManagement.stub_not_live'))
      }
    },
    onError: (err, vars) => {
      invalidate()
      // A refusal can mean the launch moved since it was shown: read it again,
      // so the row shows the current launch and the next press pins that one.
      void qc.invalidateQueries({ queryKey: ['mcpGatewayLaunchPreview', vars.name] })
      setError(i18nT(stubErrorKey(err), { name: vars.name }))
    },
  })

  const resolveRefresh = useMutation({
    mutationFn: () => api.mcpResolveRefresh(),
    onSuccess: res => {
      invalidate()
      if (!res.ok) {
        setResolveNotice(i18nT('pages.mcpManagement.resolve_no_targets'))
        return
      }
      const ready = res.ready?.length ?? 0
      // Every install failing must not read as "already up to date".
      const failed = Object.values(res.resolved ?? {}).filter(state => state === 'error').length
      if (failed > 0) {
        setResolveError(
          ready > 0
            ? i18nT('pages.mcpManagement.resolve_partly_ready', {
                ready: String(ready),
                failed: String(failed),
              })
            : i18nT('pages.mcpManagement.resolve_all_failed', { failed: String(failed) }),
        )
        return
      }
      setResolveNotice(
        ready > 0
          ? i18nT('pages.mcpManagement.resolve_ready', { ready: String(ready) })
          : i18nT('pages.mcpManagement.resolve_none_ready'),
      )
    },
    onError: err => {
      invalidate()
      // 409 is a pass already running elsewhere: information, not a failure.
      if (err instanceof ApiError && err.status === 409) {
        setResolveNotice(i18nT('pages.mcpManagement.resolve_already_running'))
        return
      }
      setError(i18nT('pages.mcpManagement.resolve_failed'))
    },
  })

  const busy = setStub.isPending || setSharing.isPending
  // One count shared by the tab badge and the assessment banner.
  const unsupportedCount = useMemo(
    () =>
      servers.filter(s => sharedWithoutSupport(s, !!status?.enabled, status?.launch_refused)).length,
    [servers, status?.enabled, status?.launch_refused],
  )
  const canEnableSharing = supported && stubCount > 0

  // Rows the measurement pass would act on, including an older gateway's row
  // with no verdict and a handshake that did not reproduce (re-measured every pass).
  const unmeasuredCount = useMemo(
    () =>
      servers.filter(
        s =>
          !s.recommendation ||
          s.recommendation.strength === 'unknown' ||
          s.recommendation.reasons.some(r => r.code === 'handshake_not_reproducible'),
      ).length,
    [servers],
  )

  const { data: measureProgress } = useQuery<McpMeasureProgress>({
    queryKey: ['mcp-measure-progress'],
    queryFn: () => api.mcpMeasureProgress(),
    enabled: false,
  })
  const stubbableNames = useMemo(
    () => servers.filter(s => s.can_stub && !s.stub && !s.share_blocked).map(s => s.name),
    [servers],
  )

  // "Share all": measure the unmeasured first, then read each candidate's launch
  // and SHOW them all. Each share approves that exact launch to run outside the
  // chat sandbox, so nothing is shared until the person presses the button
  // under the list, and each share is pinned to the launch the list shows.
  const [allPlan, setAllPlan] = useState<Array<{ name: string; preview: LaunchPreview; expected: string }> | null>(null)
  const prepareAll = useMutation({
    mutationFn: async () => {
      if (unmeasuredCount > 0) {
        await api.mcpMeasureStart()
        if (!(await waitForMeasurePass(qc))) return { pending: true as const }
      }
      // Re-read directly: the shared QueryClient never treats its cache as stale.
      const fresh = await api.mcpGatewayServers()
      const candidates = (fresh?.servers ?? [])
        .filter(s => s.can_stub && !s.stub && !s.share_blocked)
        .map(s => s.name)
      const plan: Array<{ name: string; preview: LaunchPreview; expected: string }> = []
      let unreadable = 0
      const failed: string[] = []
      for (const name of candidates) {
        try {
          const preview = await api.mcpGatewayLaunchPreview(name)
          if (preview?.complete && preview.expected_launch) {
            plan.push({ name, preview, expected: preview.expected_launch })
          } else unreadable++
        } catch {
          // A failed read is an error, not "nothing to share".
          failed.push(name)
        }
      }
      return { pending: false as const, plan, unreadable, failed }
    },
    onSuccess: r => {
      if (r.pending) {
        setNotice(i18nT('pages.mcpManagement.enable_all_still_measuring'))
        return
      }
      if (r.failed.length > 0) {
        setError(i18nT('pages.mcpManagement.enable_all_review_failed_names', { names: r.failed.join(', ') }))
      }
      if (r.plan.length === 0) {
        if (r.failed.length === 0) setNotice(i18nT('pages.mcpManagement.enable_all_review_nothing'))
        return
      }
      setAllPlan(r.plan)
      if (r.unreadable > 0) {
        setNotice(i18nT('pages.mcpManagement.enable_all_review_result_left', { count: r.unreadable }))
      }
    },
    onError: () => setError(i18nT('pages.mcpManagement.stub_failed')),
  })
  const enableAll = useMutation({
    mutationFn: async (plan: Array<{ name: string; expected: string }>) => {
      let shared = 0
      let skipped = 0
      const failed: string[] = []
      let restart = false
      let notLive = false
      // Sharing goes on BEFORE the writes, so each server is checked against the
      // bar for a pooled copy, not the looser bar for a server left unpooled.
      // Enabling can persist and still leave sharing unreachable; `ping_ok` says so.
      if (supported && !status?.enabled) {
        const on = await api.mcpGatewayEnable(true)
        if (!on.ping_ok) notLive = true
      }
      const skippedNames: string[] = []
      for (const { name, expected } of plan) {
        try {
          const res = await api.mcpGatewaySetStub(name, true, expected, true)
          if (res.stubbed?.includes(name)) shared++
          else {
            skipped++
            skippedNames.push(name)
          }
          if (res.restart_required) restart = true
        } catch {
          failed.push(name)
        }
      }
      return { shared, skipped, skippedNames, failed, restart, notLive }
    },
    onSuccess: r => {
      invalidate()
      setAllPlan(null)
      setNotice(
        [
          i18nT('pages.mcpManagement.enable_all_review_result_shared', { count: r.shared }),
          ...(r.skipped > 0
            ? [i18nT('pages.mcpManagement.enable_all_review_skipped_names', { names: r.skippedNames.join(', ') })]
            : []),
        ].join(' '),
      )
      // Failed requests and a sharing switch that did not come up are errors:
      // they go through ErrorNotice, not the status line.
      const errors = [
        ...(r.notLive ? [i18nT('pages.mcpManagement.sharing_not_live')] : []),
        ...(r.failed.length > 0
          ? [i18nT('pages.mcpManagement.enable_all_review_failed_names', { names: r.failed.join(', ') })]
          : []),
      ]
      if (errors.length > 0) setError(errors.join(' '))
      if (r.restart) setRestartNotice(i18nT('pages.mcpManagement.stub_restart_required'))
    },
    onError: () => {
      invalidate()
      setError(i18nT('pages.mcpManagement.stub_failed'))
    },
  })

  const [view, setView] = useState<McpView>('servers')
  const views: Array<TabItem<McpView>> = [
    {
      key: 'servers',
      label: i18nT('pages.mcpManagement.view_servers'),
      icon: <ServerIcon size={14} />,
    },
    {
      key: 'assessment',
      label: i18nT('pages.mcpManagement.view_assessment'),
      icon: <ListChecks size={14} />,
      count: unsupportedCount,
    },
  ]

  return (
    <Tabs
      value={view}
      onValueChange={v => setView(v as McpView)}
      layoutId="mcp-management-view"
      className="min-w-0 space-y-4"
    >
      <div className={TABS_RAIL_ROW_CLASS}>
        <TabsList aria-label={i18nT('pages.mcpManagement.views_aria')}>
          {views.map(v => (
            <TabsTrigger key={v.key} value={v.key}>
              {v.icon}
              <span>{v.label}</span>
              <TabsCount value={v.count} />
            </TabsTrigger>
          ))}
        </TabsList>
      </div>

      <ErrorNotice
        message={statusQ.isError ? i18nT('pages.mcpManagement.status_failed') : null}
        askAgent
      />

      <TabsContent value="assessment" className="min-w-0">
        <AssessmentView
          servers={servers}
          sharingOn={!!status?.enabled}
          refused={status?.launch_refused}
          loading={serversQ.isLoading}
          isError={serversQ.isError}
          onOpenServers={() => setView('servers')}
          unsupportedCount={unsupportedCount}
          unmeasuredCount={unmeasuredCount}
        />
      </TabsContent>
      <TabsContent value="servers" className="min-w-0 space-y-4">
      <p className="max-w-[76ch] text-[13px] leading-relaxed text-[var(--muted)]">
        {/* One key, one sentence, a {{link}} placeholder a translator can move. */}
        {splitOnPlaceholder(i18nT('pages.mcpManagement.lede'), 'link').map((part, i) =>
          part === null ? (
            <a
              key="link"
              href={DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[var(--accent)] hover:underline"
            >
              {i18nT('pages.mcpManagement.learn_more')}
              <ExternalLink size={12} />
            </a>
          ) : (
            <span key={i}>{part}</span>
          ),
        )}
      </p>

      <ErrorNotice message={error} askAgent onDismiss={() => setError(null)} />

      {restartNotice && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-lg border border-[var(--accent)] bg-[var(--accent-subtle,transparent)] px-3.5 py-2.5 text-[13px] text-[var(--text)]"
        >
          <RefreshCw size={14} className="mt-0.5 shrink-0 text-[var(--accent)]" aria-hidden="true" />
          <span>{restartNotice}</span>
        </div>
      )}

      {/* Per server: one labelled button is the decision. */}
      <section className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)]">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b border-[var(--border)] px-4 py-2.5">
          <span className="text-[12.5px] text-[var(--muted)]">
            {i18nT('pages.mcpManagement.stubbed_of_total', {
              stubbed: switchedOnCount,
              // Every row below, so the count and the list always agree.
              total: servers.length,
            })}
          </span>
          <Btn
            type="button"
            className={SHARE_BUTTON_CLASS}
            onClick={() => {
              setError(null)
              setNotice(null)
              setRestartNotice(null)
              prepareAll.mutate()
            }}
            disabled={
              busy
              || prepareAll.isPending
              || enableAll.isPending
              || allPlan !== null
              || serversQ.isLoading
              || !supported
              || (stubbableNames.length === 0 && unmeasuredCount === 0)
            }
          >
            {i18nT('pages.mcpManagement.enable_all')}
          </Btn>
          {(prepareAll.isPending || enableAll.isPending || notice) && (
            <span role="status" className="basis-full text-[12.5px] text-[var(--muted)]">
              {prepareAll.isPending && (measureProgress?.running || unmeasuredCount > 0)
                ? i18nT('pages.mcpManagement.assessment.measure_running', {
                    done: measureProgress?.running ? measureProgress.done : 0,
                    total: measureProgress?.running ? measureProgress.total : unmeasuredCount,
                  })
                : prepareAll.isPending
                  ? i18nT('pages.mcpManagement.share_checking')
                  : notice}
            </span>
          )}
        </div>
        {allPlan && (
          <div
            role="region"
            aria-label={i18nT('pages.mcpManagement.share_all_list_aria')}
            className="space-y-3 border-b border-[var(--border)] px-4 py-3 text-[12px] leading-relaxed text-[var(--muted)]"
          >
            <p className="font-medium text-[var(--text)]">{i18nT('pages.mcpManagement.share_all_runs')}</p>
            <p>{i18nT('pages.mcpManagement.share_all_access')}</p>
            <ul className="space-y-2.5">
              {allPlan.map(item => (
                <li key={item.name} className="space-y-1 rounded-lg border border-[var(--border)] px-3 py-2">
                  <p className="font-mono text-[12.5px] text-[var(--text)]">{item.name}</p>
                  <LaunchList preview={item.preview} />
                </li>
              ))}
            </ul>
            {!status?.enabled && servers.some(o => o.stub) && (
              <p className="text-[var(--text)]">
                {i18nT('pages.mcpManagement.share_also_starts', {
                  names: servers.filter(o => o.stub).map(o => o.name).join(', '),
                })}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Btn
                type="button"
                primary
                className={SHARE_BUTTON_CLASS}
                disabled={enableAll.isPending || busy}
                onClick={() => enableAll.mutate(allPlan)}
              >
                <Share2 size={14} aria-hidden="true" />
                {i18nT('pages.mcpManagement.share_all_confirm', { count: allPlan.length })}
              </Btn>
              <Btn
                type="button"
                className={SHARE_BUTTON_CLASS}
                disabled={enableAll.isPending}
                onClick={() => {
                  setAllPlan(null)
                  setNotice(null)
                }}
              >
                {i18nT('pages.mcpManagement.share_all_cancel')}
              </Btn>
            </div>
          </div>
        )}
        <ul className="divide-y divide-[var(--border)]">
          {servers.map(s => {
            const state = rowState(s, !!status?.enabled, status?.launch_refused)
            const waiting = state === 'needs_reapproval'
            const flagged = sharedWithoutSupport(s, !!status?.enabled, status?.launch_refused)
            const hint = waiting
              ? i18nT('pages.mcpManagement.command_changed_hint')
              : state === 'direct_env'
                ? i18nT('pages.mcpManagement.state_direct_env_reason')
                : shareHint(s)
            const hintId = `mcp-share-hint-${s.name}`
            return (
              <li key={s.name} className="px-4 py-3">
                <div className="flex min-w-0 flex-col gap-3 md:flex-row md:items-start">
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="min-w-0 break-words font-mono text-[13px] text-[var(--text)] [overflow-wrap:anywhere]">
                        {s.name}
                      </span>
                      <span
                        className={[
                          'inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px]',
                          flagged
                            ? 'border border-[var(--danger)] text-[var(--danger)]'
                            : state === 'shared'
                              ? 'bg-[var(--accent-subtle,transparent)] text-[var(--accent)]'
                              : 'text-[var(--muted)]',
                        ].join(' ')}
                      >
                        {flagged && <AlertTriangle size={11} aria-hidden="true" />}
                        {i18nT(stateLabelKey(state))}
                      </span>
                    </div>
                    {hint && (
                      <p id={hintId} className="mt-0.5 text-[12.5px] text-[var(--muted)]">
                        {hint}
                      </p>
                    )}
                    <ShareLaunch
                      server={s}
                      waiting={waiting}
                      refusal={status?.launch_refused?.[s.name]}
                      alsoStarts={
                        status?.enabled || waiting
                          ? []
                          : servers.filter(o => o.stub && o.name !== s.name).map(o => o.name)
                      }
                    />
                    <ServerDetails server={s} showLaunch={!offersShare(s, waiting)} />
                  </div>
                  <ShareAction
                    server={s}
                    waiting={waiting}
                    busy={busy}
                    supported={supported}
                    describedBy={hint ? hintId : undefined}
                    onShare={(stub, expectedLaunch) => {
                      setError(null)
                      setRestartNotice(null)
                      setStub.mutate({ name: s.name, stub, expectedLaunch })
                    }}
                  />
                </div>
              </li>
            )
          })}
          {serversQ.isError && (
            <li className="px-4 py-4">
              <ErrorNotice message={i18nT('pages.mcpManagement.servers_failed')} askAgent />
            </li>
          )}
          {servers.length === 0 && !serversQ.isLoading && !serversQ.isError && (
            <li className="px-4 py-6 text-center text-[13px] text-[var(--muted)]">
              {i18nT('pages.mcpManagement.no_servers')}
            </li>
          )}
        </ul>
        <p className="border-t border-[var(--border)] px-4 py-2.5 text-[12.5px] text-[var(--muted)]">
          {i18nT('pages.mcpManagement.open_sessions_note')}
        </p>
      </section>

      {/* Page-wide: the main sharing switch. A row's switch turns it on by itself. */}
      <section className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-3">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[14px] font-medium text-[var(--text)]">
              {i18nT('pages.mcpManagement.sharing_label')}
            </div>
            <p id="mcp-sharing-desc" className="mt-0.5 text-[12.5px] text-[var(--muted)]">
              {!supported
                ? i18nT('pages.mcpManagement.unsupported_platform')
                : !status?.enabled && stubCount === 0
                  ? i18nT('pages.mcpManagement.sharing_needs_a_stub')
                  : i18nT('pages.mcpManagement.sharing_description')}
            </p>
            {/* The switch acts at once, so the assessment's verdict sits beside it
                before the press: naming marked servers it argues against here is
                what the old confirm dialog was for. */}
            {!status?.enabled && contraryMarked.length > 0 && (
              <p className="mt-1 flex items-start gap-1.5 text-[12.5px] text-[var(--danger)]">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                <span className="break-words [overflow-wrap:anywhere]">
                  {i18nT('pages.mcpManagement.sharing_contrary', { names: contraryMarked.join(', ') })}
                </span>
              </p>
            )}
          </div>
          <Switch
            on={!!status?.enabled}
            disabled={busy || statusQ.isLoading || (!status?.enabled && !canEnableSharing)}
            label={i18nT('pages.mcpManagement.sharing_label')}
            describedBy="mcp-sharing-desc"
            onClick={() => {
              setError(null)
              setSharing.mutate(!status?.enabled)
            }}
          />
        </div>
      </section>

      {/* Page-wide: install npm servers once so chats start without a download. */}
      <section className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-3">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[14px] font-medium text-[var(--text)]">
              {i18nT('pages.mcpManagement.resolve_label')}
            </div>
            <p id="mcp-resolve-desc" className="mt-0.5 text-[12.5px] text-[var(--muted)]">
              {stubCount === 0
                ? i18nT('pages.mcpManagement.resolve_needs_a_stub')
                : i18nT('pages.mcpManagement.resolve_description')}
            </p>
            {resolveNotice && (
              <p role="status" className="mt-1 text-[12.5px] text-[var(--text)]">
                {resolveNotice}
              </p>
            )}
            <ErrorNotice variant="inline" className="mt-2" message={resolveError} askAgent />
          </div>
          <button
            type="button"
            aria-describedby="mcp-resolve-desc"
            disabled={resolveRefresh.isPending}
            onClick={() => {
              setError(null)
              setResolveNotice(null)
              setResolveError(null)
              resolveRefresh.mutate()
            }}
            className="shrink-0 rounded-lg border border-[var(--border)] px-3 py-1.5 text-[13px] text-[var(--text)] transition-colors hover:bg-[var(--hover)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {resolveRefresh.isPending
              ? i18nT('pages.mcpManagement.resolve_updating')
              : i18nT('pages.mcpManagement.resolve_update_now')}
          </button>
        </div>
      </section>
      </TabsContent>
    </Tabs>
  )
}

export default McpManagement
