/**
 * Screenshot evidence for #13598: focus ring on rename triggers after Enter.
 *
 * Frames:
 *   02-slot-rename-enter          ChatSidebar session row after Enter
 *   03-folder-list-rename-enter   ChatSidebar list-view folder header after Enter
 *   04-project-rename-enter       ProjectsPage title trigger after Enter
 *
 * Usage: node capture/shoot-rename-focus-ring-13598.mjs [outDir]
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { serveDist } from '../scripts/lib/serve-dist.mjs'
import { logPageProblems, stubDashboardApi, json } from '../scripts/lib/stub-dashboard-api.mjs'
import { chromiumExecutable } from '../scripts/lib/chromium-executable.mjs'

const OUT = process.argv[2] || '../temp-screenshots/rename-focus-ring-13598'
mkdirSync(OUT, { recursive: true })

const SLOT_KEY = 'rename-focus-slot-1'
const FOLDER_ID = 'folder-rename-focus-1'
const TASK_ID = 'task-rename-focus-1'

const SLOT = {
  key: SLOT_KEY, title: 'Rename Focus Session',
  running: false, tags: [], created: '', last_ts: '',
}
const FOLDER = {
  id: FOLDER_ID, name: 'Rename Focus Folder', collapsed: false,
  parent_id: '', color: '', icon: '',
}
const TASK_RUN = {
  task_id: TASK_ID, name: 'Alpha Project', running: false, status: 'planned',
  tasks: 1, completed: 0, failed: 0, skipped: 0, current_task: 0,
  spec: '', spec_name: 'spec', error: '', tokens_used: 0, replan_count: 0,
  task_details: [], started_at: 0, finished_at: 0, work_dir: '', branch_name: '',
  spec_content: '', lessons_learned: [], commits: 0, original_input: '', source: 'text', groups: [],
}

const { srv, base } = await serveDist()
const browser = await chromium.launch({
  executablePath: chromiumExecutable(),
  headless: true,
  args: ['--no-sandbox'],
})
const page = await browser.newPage()
await page.setViewportSize({ width: 1280, height: 800 })
logPageProblems(page)

async function capture(name, fn) {
  await fn()
  await page.waitForTimeout(400)
  const path = `${OUT}/${name}.png`
  await page.screenshot({ path })
  console.log(`captured ${name}`)
}

// ── Frame 02: Session slot rename — focus on the row after Enter ──────────
await stubDashboardApi(page, {
  slots: [SLOT],
  extra: async (path, route) => {
    if (path === '/api/sessions') return json(route, { sessions: [] }), true
    if (/\/api\/slots\/[^/]+\/rename/.test(path)) return json(route, {}), true
  },
})
await page.goto(`${base}`, { waitUntil: 'networkidle' })
await capture('02-slot-rename-enter', async () => {
  await page.waitForSelector('[data-session-title]', { timeout: 5000 }).catch(() => {})
  const titleDiv = await page.$('[data-session-title]')
  if (titleDiv) {
    await titleDiv.dblclick()
    await page.waitForSelector('textarea', { timeout: 2000 }).catch(() => {})
    const ta = await page.$('textarea')
    if (ta) { await ta.fill('Session Renamed'); await ta.press('Enter') }
  }
})

// ── Frame 03: List-view folder rename — focus on folder header after Enter ─
await stubDashboardApi(page, {
  slots: [SLOT],
  folders: [FOLDER],
  extra: async (path, route) => {
    if (path === '/api/sessions') return json(route, { sessions: [] }), true
    if (/\/api\/chat\/folders\//.test(path)) return json(route, { ...FOLDER }), true
  },
})
await page.goto(`${base}`, { waitUntil: 'networkidle' })
await capture('03-folder-list-rename-enter', async () => {
  await page.waitForSelector(`[data-folder-row="${FOLDER_ID}"]`, { timeout: 5000 }).catch(() => {})
  const folderRow = await page.$(`[data-folder-row="${FOLDER_ID}"]`)
  if (folderRow) {
    const nameSpan = await folderRow.$('[title]')
    if (nameSpan) {
      await nameSpan.dblclick()
      await page.waitForFunction(
        (rowEl) => rowEl.querySelector('input') !== null,
        folderRow,
        { timeout: 2000 },
      ).catch(() => {})
      const input = await folderRow.$('input')
      if (input) { await input.fill('Folder Renamed'); await input.press('Enter') }
    }
  }
})

// ── Frame 04: ProjectsPage title trigger — focus after Enter ──────────────
await stubDashboardApi(page, {
  extra: async (path, route) => {
    if (path === '/api/sessions') return json(route, { sessions: [] }), true
    if (path === '/api/taskrunner') return json(route, { running: false, available: true, runs: [TASK_RUN] }), true
    if (path.startsWith('/api/taskrunner/')) return json(route, { running: false, available: true, runs: [TASK_RUN] }), true
  },
})
await page.goto(`${base}/#/projects`, { waitUntil: 'networkidle' })
await capture('04-project-rename-enter', async () => {
  await page.waitForTimeout(1500)
  // Select the run from the rail
  const runBtn = await page.$('[role="button"][tabindex="0"][aria-label*="Alpha"]')
    ?? await page.$('[role="button"][tabindex="0"]')
  if (runBtn) await runBtn.click()
  await page.waitForSelector('[data-testid="project-name-trigger"]', { timeout: 3000 }).catch(() => {
    console.log('note: project-name-trigger not visible')
  })
  const trigger = await page.$('[data-testid="project-name-trigger"]')
  if (trigger) {
    await trigger.click()
    await page.waitForSelector('[data-testid="project-rename-input"]', { timeout: 2000 }).catch(() => {})
    const input = await page.$('[data-testid="project-rename-input"]')
    if (input) { await input.fill('Alpha Renamed'); await input.press('Enter') }
  }
})

await browser.close()
await srv.close()
console.log(`\nDone. Screenshots in: ${OUT}`)
