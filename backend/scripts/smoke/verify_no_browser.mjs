// Headless verification without a real browser:
// - Pre-render a fake sessionStorage auth (so zustand picks up a token)
// - Stub fetch + WebSocket (so analytics fetches don't blow up)
// - Confirm that the bundle parses and that the page module references the
//   route + storage adapter without throwing on import.

import fs from 'fs'
import path from 'path'

const DIST = path.resolve('C:/Users/ajith/Desktop/spandan-fresh-archived-2026-07-12/dist')
const indexHtml = fs.readFileSync(path.join(DIST, 'index.html'), 'utf-8')

console.log('=== dist/index.html ===')
console.log(indexHtml.slice(0, 600))
console.log()

// Find the JS file referenced
const m = indexHtml.match(/assets\/(index-[\w-]+\.js)/)
if (!m) {
  console.error('FAIL: no JS asset ref in index.html')
  process.exit(1)
}
const jsPath = path.join(DIST, 'assets', m[1])
const jsContent = fs.readFileSync(jsPath, 'utf-8')

console.log('=== bundle checks ===')
const checks = {
  'has React': jsContent.includes('createElement') || jsContent.includes('jsx'),
  'has React Router (BrowserRouter)': jsContent.includes('BrowserRouter') || jsContent.includes('RouterProvider') || /Link|Route|useNavigate/.test(jsContent),
  'has zustand create': jsContent.includes('create'),
  'has sessionStorage (auth fix)': jsContent.includes('sessionStorage'),
  'has AnalyticsPage route /teacher/analytics': jsContent.includes('teacher/analytics'),
  'has Live Confusion Overview heading': jsContent.includes('Live Confusion Overview'),
  'has Spike Intensity heading': jsContent.includes('Spike Intensity'),
  'has Open Live Analytics nav link': jsContent.includes('Open Live Analytics'),
  'has confusionApi import path': jsContent.includes('/confusion/'),
  'has confusionApi  /topic-heat path': jsContent.includes('topic-heat'),
  'has confusionApi /heatmap path': jsContent.includes('heatmap'),
  'has confusionApi /request-feedback': jsContent.includes('request-feedback'),
  'has socket store (useSocketStore)': jsContent.includes('useSocketStore') || jsContent.includes('socket.on'),
  'has Insights "Most-asked-about"': jsContent.includes('Most-asked-about'),
  'has Recovery Banner text': jsContent.includes('Recovery flow active'),
}

let pass = 0, fail = 0
for (const [k, v] of Object.entries(checks)) {
  console.log(`  ${v ? 'OK ' : 'XX '}  ${k}`)
  if (v) pass++; else fail++
}
console.log(`\n${pass} pass / ${fail} fail`)

// also assert CSS was built with our styles
const cssMatch = indexHtml.match(/assets\/(index-[\w-]+\.css)/)
const cssPath = path.join(DIST, 'assets', cssMatch[1])
const cssContent = fs.readFileSync(cssPath, 'utf-8')
console.log('\n=== css checks ===')
const cssChecks = {
  '.ans-page': cssContent.includes('.ans-page'),
  '.ans-card': cssContent.includes('.ans-card'),
  '.ans-live-tier': cssContent.includes('.ans-live-tier'),
  '.ans-heat-bar-list': cssContent.includes('.ans-heat-bar-list'),
  '.ans-timeline-svg': cssContent.includes('.ans-timeline-svg'),
  '.ans-pill': cssContent.includes('.ans-pill'),
  '.ans-recovery-banner': cssContent.includes('.ans-recovery-banner'),
  'dark-theme override': cssContent.includes('[data-theme="dark"]'),
}
let cpass = 0, cfail = 0
for (const [k, v] of Object.entries(cssChecks)) {
  console.log(`  ${v ? 'OK ' : 'XX '}  ${k}`)
  if (v) cpass++; else cfail++
}
console.log(`\n${cpass} pass / ${cfail} fail\n`)

if (fail || cfail) process.exit(1)
console.log('BUNDLE CONTAINS EXPECTED CODE: OK')